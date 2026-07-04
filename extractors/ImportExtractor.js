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
    // `import_statement`  — ESM:  import React from 'react'
    // `call_expression`   — CJS:  const x = require('./module')
    //                             const { x } = require('./module')
    // Both are intercepted here and routed in extract() by node.type.
    return ['import_statement', 'call_expression'];
  }

  /** @returns {string} */
  getFactKey() {
    return 'imports';
  }

  /**
   * @param   {object} node  import_statement or call_expression SyntaxNode
   * @returns {object|null}
   */
  extract(node) {
    if (node.type === 'import_statement') {
      return this._fromESMImport(node);
    }
    if (node.type === 'call_expression') {
      return this._fromRequire(node);
    }
    return null;
  }

  /**
   * ESM: import React, { useState } from 'react'
   */
  _fromESMImport(node) {
    const sourceNode   = node.namedChildren.find(c => c.type === 'string');
    const fragmentNode = sourceNode?.namedChildren.find(f => f.type === 'string_fragment');
    const source       = fragmentNode?.text ?? (sourceNode ? stripQuotes(sourceNode.text) : null);

    const clauseNode = node.namedChildren.find(c => c.type === 'import_clause');
    const specifiers = clauseNode ? this._collectSpecifiers(clauseNode) : [];

    return {
      line:    node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      kind:    'esm',
      source,
      specifiers,
    };
  }

  /**
   * CJS: const foo = require('./module')
   *      const { foo } = require('./module')
   *
   * CST shape:
   *   lexical_declaration
   *     variable_declarator
   *       [identifier | object_pattern]  ← binding name(s)
   *       call_expression
   *         identifier "require"
   *         arguments → string
   *
   * We only handle the case where:
   *   1. The callee is an identifier with text === 'require'
   *   2. The parent is a variable_declarator (top-level binding)
   * All other call_expressions are ignored (returned as null).
   */
  _fromRequire(node) {
    // Guard: callee must be bare `require` identifier
    const calleeNode = node.childForFieldName('function') ||
                       node.namedChildren[0];
    if (!calleeNode || calleeNode.type !== 'identifier' || calleeNode.text !== 'require') {
      return null;
    }

    // Guard: must be inside a variable_declarator
    const declarator = node.parent;
    if (!declarator || declarator.type !== 'variable_declarator') return null;

    // Source path: first string argument to require()
    const argsNode     = node.namedChildren.find(c => c.type === 'arguments');
    const stringNode   = argsNode?.namedChildren.find(c => c.type === 'string');
    const fragmentNode = stringNode?.namedChildren.find(c => c.type === 'string_fragment');
    const source       = fragmentNode?.text ?? (stringNode ? stripQuotes(stringNode.text) : null);

    // Binding name(s): identifier or object_pattern (destructured)
    const nameNode   = declarator.childForFieldName('name') ||
                       declarator.namedChildren.find(n =>
                         n.type === 'identifier' || n.type === 'object_pattern'
                       );
    const specifiers = [];

    if (nameNode?.type === 'identifier') {
      specifiers.push({ name: nameNode.text, kind: 'default' });
    } else if (nameNode?.type === 'object_pattern') {
      // const { foo, bar } = require('...')
      for (const prop of nameNode.namedChildren) {
        if (prop.type === 'shorthand_property_identifier_pattern') {
          specifiers.push({ name: prop.text, kind: 'named' });
        } else if (prop.type === 'pair_pattern') {
          // const { original: alias } = require('...')
          const alias = prop.namedChildren[1];
          if (alias) specifiers.push({ name: alias.text, kind: 'named' });
        }
      }
    }

    // Walk up to the lexical_declaration to get accurate start/end lines
    const decl = declarator.parent;

    return {
      line:    (decl ?? node).startPosition.row + 1,
      endLine: (decl ?? node).endPosition.row + 1,
      kind:    'cjs',
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
