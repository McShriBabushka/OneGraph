'use strict';

const IExtractor = require('./IExtractor');

/**
 * ExportExtractor — Extracts `export_statement` nodes.
 *
 * ─── Why `export_statement`? ─────────────────────────────────────────────
 * Tree-sitter-javascript wraps every `export …` variant in a single
 * `export_statement` node.  Intercepting it at this level lets us handle
 * the full taxonomy in one extractor without scattering logic across
 * function/class/variable extractors.
 *
 * ─── Graph meaning ───────────────────────────────────────────────────────
 * Export facts tell Stage 2 which symbols are "public API" for a file.
 * They are the counterpart to import specifiers: when File A imports 'Foo'
 * from File B, Stage 2 will resolve the edge by matching A's import specifier
 * against B's export names.
 *
 *   (File: LoanPage.jsx) -[:EXPORTS {isDefault: true}]-> (Symbol: 'LoanPage')
 *
 * ─── CST structures handled ──────────────────────────────────────────────
 *
 *   export default LoanPage
 *   ────────────────────────
 *   export_statement
 *     "default"             ← anonymous child; detected via node.type === 'default'
 *     identifier            "LoanPage"
 *
 *   export default function Foo() {}
 *   ──────────────────────────────────
 *   export_statement
 *     "default"
 *     function_declaration → identifier "Foo"
 *
 *   export default class Foo {}
 *   ─────────────────────────────
 *   export_statement
 *     "default"
 *     class_declaration → identifier "Foo"
 *
 *   export { foo, bar }
 *   export { foo } from './module'
 *   ──────────────────────────────
 *   export_statement
 *     export_clause
 *       export_specifier → identifier "foo"
 *       export_specifier → identifier "bar"
 *     string   (only for re-exports)
 *
 *   export const foo = …
 *   export function foo() {}
 *   export class Foo {}
 *   ──────────────────────
 *   export_statement
 *     declaration (lexical_declaration | function_declaration | class_declaration)
 */
class ExportExtractor extends IExtractor {
  /** @returns {string[]} */
  getNodeTypes() {
    // `export_statement`     — ESM:  export default Foo / export { foo }
    // `expression_statement` — CJS:  module.exports = { ... } / module.exports = router
    return ['export_statement', 'expression_statement'];
  }

  /** @returns {string} */
  getFactKey() {
    return 'exports';
  }

  /**
   * @param   {object} node  export_statement or expression_statement SyntaxNode
   * @returns {object|null}
   */
  extract(node) {
    if (node.type === 'export_statement') {
      return this._fromESMExport(node);
    }
    if (node.type === 'expression_statement') {
      return this._fromModuleExports(node);
    }
    return null;
  }

  /**
   * CJS: module.exports = { foo, bar }  or  module.exports = router
   *
   * CST shape:
   *   expression_statement
   *     assignment_expression
   *       member_expression  ← LHS: module.exports
   *         identifier "module"
   *         property_identifier "exports"
   *       [object | identifier | call_expression]  ← RHS
   *
   * The node type of the RHS determines the export kind:
   *   object      → shorthand_property_identifier entries are the exported names
   *   identifier  → single named export (e.g. module.exports = router)
   *   call_expression → HOC-wrapped default (e.g. module.exports = withAuth(App))
   */
  _fromModuleExports(node) {
    const assignNode = node.namedChildren.find(c => c.type === 'assignment_expression');
    if (!assignNode) return null;

    // LHS must be `module.exports`
    const lhs = assignNode.namedChildren[0];
    if (!lhs || lhs.type !== 'member_expression') return null;
    const obj  = lhs.namedChildren.find(n => n.type === 'identifier');
    const prop = lhs.namedChildren.find(n => n.type === 'property_identifier');
    if (obj?.text !== 'module' || prop?.text !== 'exports') return null;

    const rhs   = assignNode.namedChildren[1];
    if (!rhs) return null;

    const names = [];
    let   wrappedWith = null;

    if (rhs.type === 'object') {
      // module.exports = { foo, bar, baz }
      for (const child of rhs.namedChildren) {
        if (child.type === 'shorthand_property_identifier') {
          names.push(child.text);
        } else if (child.type === 'pair') {
          // module.exports = { foo: fooFn } — use the key
          const key = child.namedChildren[0];
          if (key) names.push(key.text);
        }
      }
    } else if (rhs.type === 'identifier') {
      // module.exports = router
      names.push(rhs.text);
    } else if (rhs.type === 'call_expression') {
      // module.exports = withAuth(App) or module.exports = connect()(App)
      // Record the wrapper for graph metadata; try to extract the inner name.
      const callee = rhs.childForFieldName('function') || rhs.namedChildren[0];
      wrappedWith   = callee?.text ?? null;
      // Last argument is usually the wrapped component
      const args    = rhs.namedChildren.find(c => c.type === 'arguments');
      const lastArg = args?.namedChildren[args.namedChildren.length - 1];
      if (lastArg?.type === 'identifier') names.push(lastArg.text);
    }

    if (names.length === 0 && !wrappedWith) return null;

    return {
      line:        node.startPosition.row + 1,
      endLine:     node.endPosition.row + 1,
      kind:        'cjs',
      isDefault:   true,
      names,
      source:      null,
      wrappedWith, // non-null for HOC patterns
    };
  }

  /**
   * ESM export variants (unchanged logic, endLine added).
   */
  _fromESMExport(node) {
    // Detect `export default` by looking for an anonymous 'default' child.
    const isDefault = node.children.some(c => c.type === 'default');

    // Re-export source: `export { x } from './module'`
    const sourceNode = node.namedChildren.find(c => c.type === 'string');
    const source     = sourceNode ? stripQuotes(sourceNode.text) : null;

    const names = [];

    // ── Case 1: export clause — `export { foo, bar }` ──────────────────
    const exportClause = node.namedChildren.find(c => c.type === 'export_clause');
    if (exportClause) {
      for (const specifier of exportClause.namedChildren) {
        if (specifier.type !== 'export_specifier') continue;
        // export_specifier has 1-2 identifiers: exportedName [as localName]
        const ids = specifier.namedChildren.filter(n => n.type === 'identifier');
        if (ids.length >= 1) names.push(ids[0].text);
      }
    }

    // ── Case 2: declaration export — `export const/function/class` ──────
    const DECL_TYPES = new Set([
      'function_declaration', 'generator_function_declaration',
      'class_declaration',
      'lexical_declaration', 'variable_declaration',
    ]);
    const decl = node.namedChildren.find(c => DECL_TYPES.has(c.type));
    if (decl) {
      switch (decl.type) {
        case 'function_declaration':
        case 'generator_function_declaration':
        case 'class_declaration': {
          const nameNode = decl.childForFieldName('name') ||
                           decl.namedChildren.find(n => n.type === 'identifier');
          if (nameNode) names.push(nameNode.text);
          break;
        }
        case 'lexical_declaration':
        case 'variable_declaration':
          for (const declarator of decl.namedChildren) {
            if (declarator.type !== 'variable_declarator') continue;
            const nameNode = declarator.childForFieldName('name') ||
                             declarator.namedChildren.find(n => n.type === 'identifier');
            if (nameNode) names.push(nameNode.text);
          }
          break;
        default:
          break;
      }
    }

    // ── Case 3: `export default <expression/identifier>` ────────────────
    if (isDefault && names.length === 0) {
      // Could be: identifier, object_expression, jsx_element, etc.
      const expr = node.namedChildren.find(c =>
        c.type === 'identifier' || c.type === 'object_expression'
      );
      if (expr && expr.type === 'identifier') names.push(expr.text);
    }

    return {
      line:      node.startPosition.row + 1,
      endLine:   node.endPosition.row + 1,
      kind:      'esm',
      isDefault,
      names,
      source,    // non-null for re-exports only
    };
  }
}

function stripQuotes(text) {
  return text.replace(/^['"`]|['"`]$/g, '');
}

module.exports = ExportExtractor;
