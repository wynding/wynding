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
// Still not caught, and named so no one mistakes this for a sandbox: a computed member
// (`globalThis['req' + 'uire']`), `Reflect.get(globalThis, 'require')`, `eval`, and a loader
// handed through a value the rule cannot follow (returned from a function, stored on an app
// object). This is a lint against ACCIDENTAL reaches, like the determinism zone beside it; the
// set of deliberate spellings does not terminate. The zones' downstream guards
// (`layering.test.ts` and the build-layering check) still hold whatever spelling reaches a
// module.

const MESSAGE =
  'An aliased or indirect `require` (the value passed around, `.require` on a host object, or ' +
  '`createRequire`) has no specifier the layering zones can check. Call `require()` with a ' +
  'string literal, or use `import`. See eslint-rules/no-aliased-require.mjs (#171).';

/** The global objects the loader can be read off. */
const HOSTS = new Set(['globalThis', 'global', 'window', 'self', 'module']);
/** The module that exports `createRequire`. */
const MODULE_SPECIFIERS = new Set(['module', 'node:module']);

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
    /** True when `identifier` is bound by an import from `module`/`node:module`. */
    const isModuleImport = (identifier) => {
      const variable = resolve(identifier);
      return (variable?.defs ?? []).some(
        (def) =>
          def.type === 'ImportBinding' && MODULE_SPECIFIERS.has(def.parent?.source?.value ?? ''),
      );
    };
    const report = (node) => context.report({ node, messageId: 'aliased' });

    return {
      // The loader as a VALUE: every value reference that resolves to the global `require`,
      // except the direct call the zones already judge by specifier.
      'Program:exit'() {
        for (const scope of sourceCode.scopeManager.scopes) {
          for (const reference of scope.references) {
            const id = reference.identifier;
            if (id.name !== 'require' || reference.isValueReference === false) continue;
            if (!isGlobal(id)) continue;
            const parent = id.parent;
            if (parent?.type === 'CallExpression' && parent.callee === id) continue;
            report(id);
          }
        }
      },
      // `.require` read off a host object, in either member form.
      MemberExpression(node) {
        if (node.computed || node.property.type !== 'Identifier') return;
        if (node.property.name === 'require' && isHost(node.object)) report(node);
        if (
          node.property.name === 'createRequire' &&
          node.object.type === 'Identifier' &&
          isModuleImport(node.object)
        ) {
          report(node);
        }
      },
      // The same members DESTRUCTURED, wherever a pattern takes its value: a declaration
      // (`const { require: r } = globalThis`), an assignment (`({ require: r } = globalThis)`) or
      // a parameter default (`function f({ require: r } = globalThis)`), and `createRequire` off a
      // namespace import of `module` (`const { createRequire: cr } = m`).
      ObjectPattern(node) {
        const parent = node.parent;
        const source =
          parent?.type === 'VariableDeclarator' && parent.id === node
            ? parent.init
            : (parent?.type === 'AssignmentExpression' || parent?.type === 'AssignmentPattern') &&
                parent.left === node
              ? parent.right
              : null;
        if (!source) return;
        const target = unwrap(source);
        const fromHost = isHost(target);
        const fromModule = target?.type === 'Identifier' && isModuleImport(target);
        for (const property of node.properties) {
          if (property.type !== 'Property' || property.computed) continue;
          const key = property.key.type === 'Identifier' ? property.key.name : property.key.value;
          if ((fromHost && key === 'require') || (fromModule && key === 'createRequire')) {
            report(property);
          }
        }
      },
      // `module` loaded at RUNTIME (`import('node:module')`, `require('module')`): the namespace
      // that comes back cannot be followed to its `createRequire` (`const m = await import(…)`,
      // then `m.createRequire`), so the load itself is the report. Nothing a zone ships has a
      // runtime use for that module; a static import stays allowed and is tracked above.
      ImportExpression(node) {
        if (MODULE_SPECIFIERS.has(constantString(node.source) ?? '')) report(node);
      },
      CallExpression(node) {
        if (
          node.callee.type === 'Identifier' &&
          node.callee.name === 'require' &&
          isGlobal(node.callee) &&
          MODULE_SPECIFIERS.has(constantString(node.arguments[0]) ?? '')
        ) {
          report(node);
        }
      },
      // A value RE-EXPORT from `module` (`export { createRequire } from 'node:module'`,
      // `export * from 'module'`) hands the loader factory to any file that imports the barrel,
      // where none of this can see it, so the re-export itself is the report.
      ExportNamedDeclaration(node) {
        if (node.exportKind === 'type' || !MODULE_SPECIFIERS.has(node.source?.value ?? '')) return;
        if (node.specifiers.some((spec) => spec.exportKind !== 'type')) report(node);
      },
      ExportAllDeclaration(node) {
        if (node.exportKind !== 'type' && MODULE_SPECIFIERS.has(node.source.value)) report(node);
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
