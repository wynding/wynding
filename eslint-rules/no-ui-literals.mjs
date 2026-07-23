// no-ui-literals — an ESLint rule (ADR 0004) banning user-facing string LITERALS in the
// DOM/canvas text sinks that render to players. It forces every human-readable string
// through the typed `t()` catalog accessor (a CallExpression, which this rule allows),
// so text is translatable and the i18n extraction check can see every key. It targets
// only TEXT-bearing sinks — `textContent`/`innerText`/`innerHTML`, the human-readable
// aria/title/placeholder/alt attributes, and `createTextNode` — never token attributes
// (`role`, `aria-live`, `aria-pressed`, class names, ids, event names), which are code,
// not copy. Empty strings (clearing a node) are allowed.

/** Text-bearing DOM properties (assignment sinks). */
const TEXT_PROPS = new Set([
  'textContent',
  'innerText',
  'innerHTML',
  'ariaLabel',
  'ariaDescription',
  'ariaRoleDescription',
  'title',
  'placeholder',
  'alt',
]);

/** Human-readable attribute names when set via setAttribute(name, value). */
const TEXT_ATTRS = new Set([
  'aria-label',
  'aria-description',
  'aria-roledescription',
  'title',
  'placeholder',
  'alt',
]);

/** A non-empty string literal or a no-substitution template literal. */
function badLiteral(node) {
  if (node == null) return false;
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value.trim() !== '';
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0) {
    return (node.quasis[0]?.value?.cooked ?? '').trim() !== '';
  }
  return false;
}

const MESSAGE = "User-facing string literal — resolve it through t('key') from the i18n catalog.";

/** @type {import('eslint').Rule.RuleModule} */
const noUiLiterals = {
  meta: {
    type: 'problem',
    docs: { description: 'Ban user-facing string literals in DOM/aria/text sinks (use t()).' },
    schema: [],
    messages: { literal: MESSAGE },
  },
  create(context) {
    return {
      AssignmentExpression(node) {
        if (node.left.type !== 'MemberExpression') return;
        const prop = node.left.property;
        // Resolve the property name for BOTH `el.textContent = …` (non-computed Identifier)
        // and `el['textContent'] = …` (computed string Literal) so a computed write can't
        // bypass the ban.
        let name = null;
        if (!node.left.computed && prop.type === 'Identifier') name = prop.name;
        else if (node.left.computed && prop.type === 'Literal' && typeof prop.value === 'string') {
          name = prop.value;
        }
        if (name !== null && TEXT_PROPS.has(name) && badLiteral(node.right)) {
          context.report({ node: node.right, messageId: 'literal' });
        }
      },
      CallExpression(node) {
        if (node.callee.type !== 'MemberExpression' || node.callee.property.type !== 'Identifier') {
          return;
        }
        const method = node.callee.property.name;
        if (method === 'createTextNode' && badLiteral(node.arguments[0])) {
          context.report({ node: node.arguments[0], messageId: 'literal' });
        }
        // append(...nodesOrStrings) / prepend(...): a bare string arg renders as text.
        if (method === 'append' || method === 'prepend') {
          for (const arg of node.arguments) {
            if (badLiteral(arg)) context.report({ node: arg, messageId: 'literal' });
          }
        }
        // insertAdjacentText(position, text) / insertAdjacentHTML(position, html):
        // the SECOND argument is the user-facing text.
        if (method === 'insertAdjacentText' || method === 'insertAdjacentHTML') {
          if (badLiteral(node.arguments[1])) {
            context.report({ node: node.arguments[1], messageId: 'literal' });
          }
        }
        if (method === 'setAttribute') {
          const [attr, value] = node.arguments;
          if (
            attr != null &&
            attr.type === 'Literal' &&
            typeof attr.value === 'string' &&
            TEXT_ATTRS.has(attr.value) &&
            badLiteral(value)
          ) {
            context.report({ node: value, messageId: 'literal' });
          }
        }
      },
    };
  },
};

export default {
  rules: { 'no-ui-literals': noUiLiterals },
};
