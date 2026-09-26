// no-aliased-require: an ESLint rule (#171) rejecting every way to reach Node's module loader
// that the layering zones cannot judge by specifier. `require('x')` called directly is left to
// the zones' SPECIFIER SITES, which read its specifier. Everything else that reaches the loader
// has no specifier to read: the loader passed around as a value (`(0, require)(…)`,
// `const r = require`), read off a host object (`globalThis.require`, the same member
// destructured), or reached through Node's `module` builtin.
//
// THE `module` BUILTIN IS REPORTED WHERE IT ENTERS, NOT WHERE IT IS USED. Its exports carry the
// loader many ways over (`createRequire`, `Module.createRequire`, `Module.prototype.require`,
// `new Module().require`, the default export, a rest spread of the namespace…), and review after
// review found one more use to follow (Codex, PR #174). So a value import of anything that
// carries it (the namespace, the default, `Module`, `createRequire`) is the report, as a runtime
// load (`import('node:module')`, `require('module')`, `getBuiltinModule('node:module')`) always
// was, and so is the CommonJS `module` object, whose `require`, `constructor` and `parent` reach
// the same loader. Only the inert exports (`builtinModules`, `isBuiltin`, `findSourceMap`,
// `SourceMap`) may be imported or re-exported; `typeof module` as a feature check is fine.
//
// SCOPE-RESOLVED, NOT SPELLING-BASED. The first form of this was a set of esquery selectors on
// the identifier `require`, and review after review found another position where that spelling
// is not the loader: an object key, a class or interface member, a function, parameter, rest,
// default, destructured, import or catch binding named `require` (Codex and CodeRabbit, PR
// #174). Each exclusion invited the next. Here a name counts only when ESLint's scope analysis
// resolves it to the GLOBAL `require` (a configured global, or no binding at all), so a local
// binding of that name, and every non-reference position, is simply not the loader.
//
// Still not caught, and named so no one mistakes this for a sandbox: a computed member whose
// key is not a constant string (`globalThis['req' + 'uire']`), `Reflect.get(globalThis,
// 'require')`, `eval`, and a loader handed through a value the rule cannot follow (returned from
// a function, stored on an app object, bound by `let` and reassigned). This is a lint against ACCIDENTAL reaches, like the determinism zone beside it; the
// set of deliberate spellings does not terminate. The zones' downstream guards
// (`layering.test.ts` and the build-layering check) still hold whatever spelling reaches a
// module.

const MESSAGE =
  'An aliased or indirect `require` (the value passed around, `.require` on a host object, or ' +
  "Node's `module` builtin or CommonJS `module` object) has no specifier the layering zones can " +
  'check. Call `require()` with a string literal, or use `import`. See ' +
  'eslint-rules/no-aliased-require.mjs (#171).';

/** The global objects the loader can be read off. (The CommonJS `module` is reported whole.) */
const HOSTS = new Set(['globalThis', 'global', 'window', 'self']);
/** The exports of `module` known to be INERT, the only ones a zone may import or re-export. Every
 *  other one reaches the loader: `createRequire`, `Module` and the default (`.createRequire`,
 *  `.prototype.require`; Codex, PR #174), and, because the ESM named exports are every own
 *  property of `Module`, `_load`, `_resolveFilename`, `register`, `runMain` and the rest. An
 *  allowlist, since that list grows with Node. */
const INERT_MODULE_EXPORTS = new Set(['builtinModules', 'isBuiltin', 'findSourceMap', 'SourceMap']);
/** The module that exports `createRequire`. */
const MODULE_SPECIFIERS = new Set(['module', 'node:module']);
/** The module whose `getBuiltinModule` hands back any builtin's namespace, `module` included. */
const PROCESS_SPECIFIERS = new Set(['process', 'node:process']);
/** The exports of `process` that carry `getBuiltinModule`: the function and the default. */
const PROCESS_LOADER_EXPORTS = new Set(['getBuiltinModule', 'default']);

/** Unwraps TypeScript's value-preserving wrappers (`x as T`, `x!`, `x satisfies T`) and parens. */
function unwrap(node) {
  let current = node;
  while (
    current &&
    (current.type === 'TSAsExpression' ||
      current.type === 'TSNonNullExpression' ||
      current.type === 'TSSatisfiesExpression' ||
      current.type === 'TSTypeAssertion')
  ) {
    current = current.expression;
  }
  return current;
}

/** A constant string specifier's value (a string literal or a no-substitution template, the two
 *  spellings the zones' SPECIFIER SITES treat as one), or undefined for anything else. */
function constantString(node) {
  const target = unwrap(node);
  if (target?.type === 'Literal' && typeof target.value === 'string') return target.value;
  if (target?.type === 'TemplateLiteral' && target.expressions.length === 0) {
    return target.quasis[0]?.value.cooked ?? undefined;
  }
  return undefined;
}

/** A member's constant name: `a.b`, or a computed `a['b']` whose key is a constant string. */
function memberName(node) {
  if (!node.computed) return node.property.type === 'Identifier' ? node.property.name : undefined;
  return constantString(node.property);
}

/** A destructuring property's constant key (`{ a }`, `{ 'a': x }`, `{ ['a']: x }`). */
function propertyKey(property) {
  if (property.computed) return constantString(property.key);
  return property.key.type === 'Identifier' ? property.key.name : property.key.value;
}

/** True inside a `typeof x` TYPE query, which is erased and cannot call anything. */
function inTypeQuery(node) {
  for (let current = node.parent; current; current = current.parent) {
    if (current.type === 'TSTypeQuery') return true;
  }
  return false;
}

const noAliasedRequire = {
  meta: {
    type: 'problem',
    docs: { description: 'Reject aliased or indirect access to the module loader (#171).' },
    messages: { aliased: MESSAGE },
    schema: [],
  },
  create(context) {
    const sourceCode = context.sourceCode;

    /** The variable `identifier` resolves to, or null when it resolves to nothing. */
    const resolve = (identifier) => {
      for (let scope = sourceCode.getScope(identifier); scope; scope = scope.upper) {
        const variable = scope.set.get(identifier.name);
        if (variable) return variable;
      }
      return null;
    };
    /** True when `identifier` is the ambient global of that name, not a local binding. */
    const isGlobal = (identifier) => {
      const variable = resolve(identifier);
      return variable === null || (variable.scope.type === 'global' && variable.defs.length === 0);
    };
    /** True when `node` is a global host object (`globalThis`, `module`, …). */
    const isHost = (node) => {
      const target = unwrap(node);
      return target?.type === 'Identifier' && HOSTS.has(target.name) && isGlobal(target);
    };
    /** True when `node` is `getBuiltinModule` (Codex, PR #174), which hands back any builtin's
     *  namespace, `module` included. It is judged BY NAME off any object (`process`,
     *  `globalThis.process`, an alias or import of either, its `default`), because `process`
     *  itself can be aliased without end; or as a binding: a named import from `node:process`, a
     *  variable bound to it, or a destructured `getBuiltinModule` key, renamed or defaulted. */
    const isBuiltinLoader = (node, seen = new Set()) => {
      const target = unwrap(node);
      if (!target || seen.has(target)) return false;
      seen.add(target);
      if (target.type === 'MemberExpression') return memberName(target) === 'getBuiltinModule';
      if (target.type !== 'Identifier') return false;
      return (resolve(target)?.defs ?? []).some((def) => {
        if (def.type === 'ImportBinding') {
          if (def.node.type !== 'ImportSpecifier') return false;
          if (def.parent.importKind === 'type' || def.node.importKind === 'type') return false;
          const imported =
            def.node.imported.type === 'Identifier'
              ? def.node.imported.name
              : def.node.imported.value;
          return (
            imported === 'getBuiltinModule' &&
            PROCESS_SPECIFIERS.has(def.parent?.source?.value ?? '')
          );
        }
        if (def.type !== 'Variable' && def.type !== 'Parameter') return false;
        if (def.type === 'Variable' && def.node.id === def.name) {
          return isBuiltinLoader(def.node.init, seen);
        }
        let value = def.name;
        if (value.parent?.type === 'AssignmentPattern' && value.parent.left === value) {
          if (isBuiltinLoader(value.parent.right, seen)) return true;
          value = value.parent;
        }
        const property = value.parent;
        return (
          property?.type === 'Property' &&
          property.value === value &&
          property.parent?.type === 'ObjectPattern' &&
          propertyKey(property) === 'getBuiltinModule'
        );
      });
    };
    /** The outermost node `node` stands for once its value-preserving wrappers are climbed
     *  (`x as T`, `x!`, `x satisfies T`, `<T>x`, an optional chain). */
    const outermost = (node) => {
      let current = node;
      while (
        current.parent &&
        (current.parent.type === 'ChainExpression' ||
          current.parent.type === 'TSAsExpression' ||
          current.parent.type === 'TSNonNullExpression' ||
          current.parent.type === 'TSSatisfiesExpression' ||
          current.parent.type === 'TSTypeAssertion') &&
        current.parent.expression === current
      ) {
        current = current.parent;
      }
      return current;
    };
    /** True when `node` is only tested by a value `typeof` (a feature check such as
     *  `typeof module !== 'undefined'` or `typeof process.getBuiltinModule === 'function'`), which
     *  cannot hand the value on, through any wrapper (Codex, PR #174). */
    const isTypeofOperand = (node) => {
      const parent = outermost(node).parent;
      return parent?.type === 'UnaryExpression' && parent.operator === 'typeof';
    };
    /** True when `node` is the callee of the call it sits in (`f(x)`, `(f as T)(x)`, `f!(x)`, not
     *  `f.call(x)`), or only a `typeof` operand. */
    const isCallee = (node) => {
      if (isTypeofOperand(node)) return true;
      const current = outermost(node);
      return current.parent?.type === 'CallExpression' && current.parent.callee === current;
    };
    const report = (node) => context.report({ node, messageId: 'aliased' });

    return {
      // The loader as a VALUE: every value reference that resolves to the global `require`,
      // except the direct call the zones already judge by specifier.
      'Program:exit'() {
        for (const scope of sourceCode.scopeManager.scopes) {
          for (const reference of scope.references) {
            const id = reference.identifier;
            // `getBuiltinModule` bound to a name and used as anything but a direct call (passed,
            // bound, re-exported) escapes the specifier check below, so the use is the report.
            if (
              id.name !== 'require' &&
              reference.isRead() &&
              !isCallee(id) &&
              !inTypeQuery(id) &&
              isBuiltinLoader(id)
            ) {
              report(id);
              continue;
            }
            // The CommonJS `module` object: its `require`, `constructor` (the `Module` class) and
            // `parent` all reach the loader, and no zone is CommonJS, so any use is the report.
            if (
              id.name === 'module' &&
              reference.isValueReference !== false &&
              isGlobal(id) &&
              !inTypeQuery(id) &&
              !isTypeofOperand(id)
            ) {
              report(id);
              continue;
            }
            if (id.name !== 'require' || reference.isValueReference === false) continue;
            if (!isGlobal(id) || inTypeQuery(id)) continue;
            const parent = id.parent;
            if (parent?.type === 'CallExpression' && parent.callee === id) continue;
            report(id);
          }
        }
      },
      // `.require` read off a host object, in either member form.
      MemberExpression(node) {
        const name = memberName(node);
        if (name === 'require' && isHost(node.object)) report(node);
        // `getBuiltinModule` read as a value (`.bind`, `.call`, stored, exported) rather than
        // called directly, where the call's specifier is checked.
        if (name === 'getBuiltinModule' && !isCallee(node)) report(node);
      },
      // The same member DESTRUCTURED, wherever a pattern takes its value: a declaration
      // (`const { require: r } = globalThis`), an assignment (`({ require: r } = globalThis)`) or
      // a parameter default (`function f({ require: r } = globalThis)`).
      ObjectPattern(node) {
        const parent = node.parent;
        const source =
          parent?.type === 'VariableDeclarator' && parent.id === node
            ? parent.init
            : (parent?.type === 'AssignmentExpression' || parent?.type === 'AssignmentPattern') &&
                parent.left === node
              ? parent.right
              : null;
        if (!source || !isHost(source)) return;
        for (const property of node.properties) {
          if (property.type === 'Property' && propertyKey(property) === 'require') {
            report(property);
          }
        }
      },
      // `module` loaded at RUNTIME (`import('node:module')`, `require('module')`,
      // `process.getBuiltinModule('node:module')`): the namespace
      // that comes back cannot be followed to its `createRequire` (`const m = await import(…)`,
      // then `m.createRequire`), so the load itself is the report, like the static import below.
      ImportExpression(node) {
        if (MODULE_SPECIFIERS.has(constantString(node.source) ?? '')) report(node);
      },
      CallExpression(node) {
        // `getBuiltinModule('node:module')` returns the same namespace as a runtime import, and
        // a non-constant specifier could be that one, so either is the report.
        if (isBuiltinLoader(node.callee)) {
          const specifier = constantString(node.arguments[0]);
          if (specifier === undefined || MODULE_SPECIFIERS.has(specifier)) report(node);
        }
        if (
          node.callee.type === 'Identifier' &&
          node.callee.name === 'require' &&
          isGlobal(node.callee) &&
          MODULE_SPECIFIERS.has(constantString(node.arguments[0]) ?? '')
        ) {
          report(node);
        }
      },
      // A value RE-EXPORT of what carries the loader (`export { createRequire } from
      // 'node:module'`, `Module`, the default, or any `export * from 'module'`) hands it to any
      // file that imports the barrel, where none of this can see it, so the re-export is the
      // report. A named re-export of anything else (`builtinModules`, `isBuiltin`) is not.
      ExportNamedDeclaration(node) {
        if (node.exportKind === 'type' || !node.source) return;
        const names = (spec) =>
          spec.local.type === 'Identifier' ? spec.local.name : spec.local.value;
        // `getBuiltinModule` re-exported from `node:process` (or the default, which carries it)
        // leaves the specifier check behind the same way.
        const fromModule = MODULE_SPECIFIERS.has(node.source.value);
        if (!fromModule && !PROCESS_SPECIFIERS.has(node.source.value)) return;
        for (const spec of node.specifiers) {
          if (spec.exportKind === 'type') continue;
          const carried = fromModule
            ? !INERT_MODULE_EXPORTS.has(names(spec))
            : PROCESS_LOADER_EXPORTS.has(names(spec));
          if (carried) report(spec);
        }
      },
      ExportAllDeclaration(node) {
        if (node.exportKind === 'type') return;
        const source = node.source.value;
        if (MODULE_SPECIFIERS.has(source) || PROCESS_SPECIFIERS.has(source)) report(node);
      },
      // The builtin itself, imported as a VALUE: the namespace, the default, or any named export
      // outside `INERT_MODULE_EXPORTS`, renamed or not. A TYPE-ONLY import is erased and carries
      // nothing.
      ImportDeclaration(node) {
        if (node.importKind === 'type' || !MODULE_SPECIFIERS.has(node.source.value)) return;
        for (const spec of node.specifiers) {
          if (spec.type !== 'ImportSpecifier') {
            report(spec);
            continue;
          }
          if (spec.importKind === 'type') continue;
          const imported =
            spec.imported.type === 'Identifier' ? spec.imported.name : spec.imported.value;
          if (!INERT_MODULE_EXPORTS.has(imported)) report(spec);
        }
      },
    };
  },
};

export default noAliasedRequire;
