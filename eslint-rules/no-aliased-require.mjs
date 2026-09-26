// no-aliased-require: an ESLint rule (#171) rejecting every way to reach Node's module loader
// that the layering zones cannot judge by specifier. `require('x')` called directly is left to
// the zones' SPECIFIER SITES, which read its specifier. Everything else that reaches the loader
// has no specifier to read: the loader passed around as a value (`(0, require)(…)`,
// `const r = require`), read off a host object (`globalThis.require`, `module.require`, the same
// member destructured) or minted by `createRequire`.
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
  '`createRequire`) has no specifier the layering zones can check. Call `require()` with a ' +
  'string literal, or use `import`. See eslint-rules/no-aliased-require.mjs (#171).';

/** The global objects the loader can be read off. */
const HOSTS = new Set(['globalThis', 'global', 'window', 'self', 'module']);
/** The exports of `module` that carry the loader factory: `createRequire` itself, and `Module`
 *  and the default export, which both expose it as `.createRequire` (Codex, PR #174). */
const LOADER_EXPORTS = new Set(['createRequire', 'Module', 'default']);
/** The module that exports `createRequire`. */
const MODULE_SPECIFIERS = new Set(['module', 'node:module']);
/** The module whose `getBuiltinModule` hands back any builtin's namespace, `module` included. */
const PROCESS_SPECIFIERS = new Set(['process', 'node:process']);
/** The exports of `process` that carry `getBuiltinModule`: the function and the default. */
const PROCESS_LOADER_EXPORTS = new Set(['getBuiltinModule', 'default']);
/** The members of that module's exports that carry `createRequire` themselves (`m.Module`,
 *  `m.default`, and either of those again), so a chain through them is still the factory. */
const LOADER_HOLDERS = new Set(['Module', 'default']);

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
    /** True when `node` evaluates to the `module` exports or to a member of them that carries
     *  `createRequire` (Codex, PR #174): an import from the module (`import * as m`, the default
     *  import, `import { Module }`), `Module` or `default` read off one (`m.Module`,
     *  `m.default.Module`), or a variable or parameter bound to either, directly, by a default or
     *  by destructuring (`const M = m.Module`, `const { Module: { createRequire } } = m`,
     *  `function f({ Module: M } = m)`). */
    const isLoaderBearing = (node, seen = new Set()) => {
      const target = unwrap(node);
      if (!target || seen.has(target)) return false;
      seen.add(target);
      if (target.type === 'MemberExpression') {
        return LOADER_HOLDERS.has(memberName(target) ?? '') && isLoaderBearing(target.object, seen);
      }
      if (target.type !== 'Identifier') return false;
      const variable = resolve(target);
      return (variable?.defs ?? []).some((def) => {
        if (def.type === 'ImportBinding') {
          if (!MODULE_SPECIFIERS.has(def.parent?.source?.value ?? '')) return false;
          // A type-only import is erased and carries nothing.
          if (def.parent.importKind === 'type' || def.node.importKind === 'type') return false;
          // The namespace and the default are the exports; a named import only when it is a
          // holder (`Module`, or `default` by name). `builtinModules` and the rest are not.
          if (def.node.type !== 'ImportSpecifier') return true;
          const imported =
            def.node.imported.type === 'Identifier'
              ? def.node.imported.name
              : def.node.imported.value;
          return LOADER_HOLDERS.has(imported);
        }
        if (def.type !== 'Variable' && def.type !== 'Parameter') return false;
        if (def.type === 'Variable' && def.node.id === def.name) {
          return isLoaderBearing(def.node.init, seen);
        }
        // An object REST off a loader-bearing object keeps every export it did not name, so it
        // is the exports again (`const { ...host } = m`; Codex, PR #174).
        if (
          def.name.parent?.type === 'RestElement' &&
          def.name.parent.parent?.type === 'ObjectPattern'
        ) {
          return patternIsLoaderBearing(def.name.parent.parent, seen);
        }
        // A default on the binding itself (`{ Module: M = m.Module }`, `function f(M = m)`).
        let value = def.name;
        if (value.parent?.type === 'AssignmentPattern' && value.parent.left === value) {
          if (isLoaderBearing(value.parent.right, seen)) return true;
          value = value.parent;
        }
        // Destructured: the binding's property must be a holder, off a loader-bearing object.
        const property = value.parent;
        return (
          property?.type === 'Property' &&
          property.value === value &&
          LOADER_HOLDERS.has(propertyKey(property) ?? '') &&
          patternIsLoaderBearing(property.parent, seen)
        );
      });
    };
    /** True when the object `pattern` destructures is loader-bearing: its declaration, assignment
     *  or default source, or, for a nested pattern, a holder property of a loader-bearing one. */
    const patternIsLoaderBearing = (pattern, seen = new Set()) => {
      const parent = pattern?.parent;
      if (!parent) return false;
      if (parent.type === 'VariableDeclarator' && parent.id === pattern) {
        return isLoaderBearing(parent.init, seen);
      }
      if (parent.type === 'AssignmentExpression' && parent.left === pattern) {
        return isLoaderBearing(parent.right, seen);
      }
      let value = pattern;
      if (parent.type === 'AssignmentPattern' && parent.left === pattern) {
        if (isLoaderBearing(parent.right, seen)) return true;
        value = parent;
      }
      const property = value.parent;
      return (
        property?.type === 'Property' &&
        property.value === value &&
        LOADER_HOLDERS.has(propertyKey(property) ?? '') &&
        property.parent?.type === 'ObjectPattern' &&
        patternIsLoaderBearing(property.parent, seen)
      );
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
    /** True when `node` is the callee of the call it sits in (`f(x)`, `(f as T)(x)`, `f!(x)`, not
     *  `f.call(x)`), or only tested by a value `typeof` (the Node-version guard,
     *  `typeof process.getBuiltinModule === 'function'`), which cannot hand the function on. */
    const isCallee = (node) => {
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
      const parent = current.parent;
      if (parent?.type === 'UnaryExpression' && parent.operator === 'typeof') return true;
      return parent?.type === 'CallExpression' && parent.callee === current;
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
        if (name === 'createRequire' && isLoaderBearing(node.object)) report(node);
        // `getBuiltinModule` read as a value (`.bind`, `.call`, stored, exported) rather than
        // called directly, where the call's specifier is checked.
        if (name === 'getBuiltinModule' && !isCallee(node)) report(node);
      },
      // The same members DESTRUCTURED, wherever a pattern takes its value: a declaration
      // (`const { require: r } = globalThis`), an assignment (`({ require: r } = globalThis)`) or
      // a parameter default (`function f({ require: r } = globalThis)`), and `createRequire` off
      // anything loader-bearing (`const { createRequire: cr } = m`, or nested through a holder:
      // `const { Module: { createRequire } } = m`).
      ObjectPattern(node) {
        const parent = node.parent;
        const source =
          parent?.type === 'VariableDeclarator' && parent.id === node
            ? parent.init
            : (parent?.type === 'AssignmentExpression' || parent?.type === 'AssignmentPattern') &&
                parent.left === node
              ? parent.right
              : null;
        const fromHost = source ? isHost(source) : false;
        const fromModule = patternIsLoaderBearing(node);
        if (!fromHost && !fromModule) return;
        for (const property of node.properties) {
          if (property.type !== 'Property') continue;
          const key = propertyKey(property);
          if ((fromHost && key === 'require') || (fromModule && key === 'createRequire')) {
            report(property);
          }
        }
      },
      // `module` loaded at RUNTIME (`import('node:module')`, `require('module')`,
      // `process.getBuiltinModule('node:module')`): the namespace
      // that comes back cannot be followed to its `createRequire` (`const m = await import(…)`,
      // then `m.createRequire`), so the load itself is the report. Nothing a zone ships has a
      // runtime use for that module; a static import stays allowed and is tracked above.
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
      // A value RE-EXPORT of `createRequire` (`export { createRequire } from 'node:module'`, or
      // any `export * from 'module'`, which includes it) hands the loader factory to any file
      // that imports the barrel, where none of this can see it, so the re-export is the report.
      // `Module` and the default export carry it too. A named re-export of anything else
      // (`builtinModules`, `isBuiltin`) is not a loader.
      //
      // A LOCAL export of a loader-bearing binding hands the factory on the same way
      // (`import m from 'node:module'; export { m }`, `export const M = m.Module`,
      // `export default m`), so it is reported too (CodeRabbit, PR #174).
      ExportDefaultDeclaration(node) {
        if (isLoaderBearing(node.declaration)) report(node);
      },
      TSExportAssignment(node) {
        if (isLoaderBearing(node.expression)) report(node);
      },
      ExportNamedDeclaration(node) {
        if (node.exportKind === 'type') return;
        if (!node.source) {
          for (const spec of node.specifiers) {
            if (spec.exportKind !== 'type' && isLoaderBearing(spec.local)) report(spec);
          }
          // Each exported BINDING is judged, not the declarator: `export const { Module: M } = m`
          // exports a holder, `export const { builtinModules } = m` does not, and
          // `export const { createRequire } = m` is already reported by `ObjectPattern` above.
          for (const declarator of node.declaration?.declarations ?? []) {
            for (const variable of sourceCode.getDeclaredVariables(declarator)) {
              const binding = variable.identifiers[0];
              if (binding && isLoaderBearing(binding)) report(binding);
            }
          }
          return;
        }
        const names = (spec) =>
          spec.local.type === 'Identifier' ? spec.local.name : spec.local.value;
        // `getBuiltinModule` re-exported from `node:process` (or the default, which carries it)
        // leaves the specifier check behind the same way.
        const carried = MODULE_SPECIFIERS.has(node.source.value)
          ? LOADER_EXPORTS
          : PROCESS_SPECIFIERS.has(node.source.value)
            ? PROCESS_LOADER_EXPORTS
            : null;
        if (!carried) return;
        for (const spec of node.specifiers) {
          if (spec.exportKind !== 'type' && carried.has(names(spec))) report(spec);
        }
      },
      ExportAllDeclaration(node) {
        if (node.exportKind === 'type') return;
        const source = node.source.value;
        if (MODULE_SPECIFIERS.has(source) || PROCESS_SPECIFIERS.has(source)) report(node);
      },
      // `createRequire` imported by name (identifier or string), renamed or not. A TYPE-ONLY
      // import is erased and cannot mint a loader, so it is left alone.
      ImportSpecifier(node) {
        if (node.importKind === 'type' || node.parent.importKind === 'type') return;
        const imported =
          node.imported.type === 'Identifier' ? node.imported.name : node.imported.value;
        if (imported === 'createRequire' && MODULE_SPECIFIERS.has(node.parent.source.value)) {
          report(node);
        }
      },
    };
  },
};

export default noAliasedRequire;
