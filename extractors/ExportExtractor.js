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
    return ['export_statement'];
  }

  /** @returns {string} */
  getFactKey() {
    return 'exports';
  }

  /**
   * @param   {object} node  export_statement SyntaxNode
   * @returns {object}
   */
  extract(node) {
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
