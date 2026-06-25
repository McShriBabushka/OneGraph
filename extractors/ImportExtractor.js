'use strict';

const IExtractor = require('./IExtractor');

/**
 * ImportExtractor — Extracts `import_declaration` nodes.
 *
 * ─── Why `import_declaration`? ───────────────────────────────────────────
 * Tree-sitter-javascript produces one `import_declaration` node for every
 * ES-module import statement.  It is the single authoritative node that
 * groups together the module path and all imported bindings, making it the
 * cleanest hook for dependency-edge extraction.
 *
 * ─── Graph meaning ───────────────────────────────────────────────────────
 * Each import fact becomes a directed DEPENDS_ON edge in the dependency graph:
 *
 *   (File: LoanPage.jsx) -[:IMPORTS {specifiers: ['useState']}]-> (Module: 'react')
 *
 * Relative imports (source starts with '.') will later be resolved to actual
 * file nodes.  Bare specifiers ('react', 'lodash') point to external package
 * nodes.
 *
 * ─── CST structure handled ───────────────────────────────────────────────
 *
 *   import React from 'react'
 *   ──────────────────────────
 *   import_declaration
 *     import_clause
 *       identifier              "React"         ← default specifier
 *     string                    "'react'"        ← module source
 *
 *   import { useState, useEffect } from 'react'
 *   ───────────────────────────────────────────
 *   import_declaration
 *     import_clause
 *       named_imports
 *         import_specifier → identifier "useState"
 *         import_specifier → identifier "useEffect"
 *     string                    "'react'"
 *
 *   import * as Lib from './lib'
 *   ────────────────────────────
 *   import_declaration
 *     import_clause
 *       namespace_import → identifier "Lib"
 *     string              "'./lib'"
 *
 *   import DefaultExport, { named } from './module'
 *   ─────────────────────────────────────────────────
 *   import_declaration
 *     import_clause
 *       identifier              "DefaultExport"
 *       named_imports → ...
 *     string                    "'./module'"
 */
class ImportExtractor extends IExtractor {
  /** @returns {string[]} */
  getNodeTypes() {
    // `import_declaration` covers all ES6 import statement variants.
    // `require` calls are handled by CallExtractor as call_expression nodes.
    return ['import_declaration'];
  }

  /** @returns {string} */
  getFactKey() {
    return 'imports';
  }

  /**
   * @param   {object} node  import_declaration SyntaxNode
   * @returns {object}
   */
  extract(node) {
    // The module path is always a `string` named child.
    // node.text for a Tree-sitter string includes the quote chars, e.g. "'react'".
    const sourceNode = node.namedChildren.find(c => c.type === 'string');
    const source     = sourceNode ? stripQuotes(sourceNode.text) : null;

    // Walk the import_clause (if present) to collect all specifiers.
    const clauseNode  = node.namedChildren.find(c => c.type === 'import_clause');
    const specifiers  = clauseNode ? this._collectSpecifiers(clauseNode) : [];

    return {
      line:       node.startPosition.row + 1,
      source,
      specifiers,
    };
  }

  // ── private ────────────────────────────────────────────────────────────

  /**
   * Collect every binding introduced by an import_clause.
   *
   * @param   {object}   clauseNode  import_clause SyntaxNode
   * @returns {object[]}
   */
  _collectSpecifiers(clauseNode) {
    const specifiers = [];

    for (const child of clauseNode.namedChildren) {
      switch (child.type) {
        // `import Default from '…'`
        case 'identifier':
          specifiers.push({ name: child.text, kind: 'default' });
          break;

        // `import { foo, bar as baz } from '…'`
        case 'named_imports':
          for (const specifier of child.namedChildren) {
            if (specifier.type !== 'import_specifier') continue;

            // import_specifier has 1 identifier (name only) or 2 (original + alias).
            // Grammar: name [as alias]
            const names = specifier.namedChildren.filter(n => n.type === 'identifier');
            if (names.length === 1) {
              specifiers.push({ name: names[0].text, kind: 'named' });
            } else if (names.length >= 2) {
              // first is the exported name, second is the local alias
              specifiers.push({ name: names[1].text, originalName: names[0].text, kind: 'named' });
            }
          }
          break;

        // `import * as Lib from '…'`
        case 'namespace_import': {
          const id = child.namedChildren.find(n => n.type === 'identifier');
          if (id) specifiers.push({ name: id.text, kind: 'namespace' });
          break;
        }

        default:
          break;
      }
    }

    return specifiers;
  }
}

/**
 * Remove surrounding quote characters from a Tree-sitter string node's text.
 * Handles 'single', "double", and `template` literals.
 *
 * @param {string} text
 * @returns {string}
 */
function stripQuotes(text) {
  return text.replace(/^['"`]|['"`]$/g, '');
}

module.exports = ImportExtractor;
