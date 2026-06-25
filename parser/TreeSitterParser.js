'use strict';

const fs         = require('fs');
const TreeSitter = require('tree-sitter');
const JavaScript = require('tree-sitter-javascript');
const IParser    = require('./IParser');

/**
 * TreeSitterParser — Concrete IParser for JavaScript and JSX.
 *
 * Tree-sitter produces a Concrete Syntax Tree (CST), not a classic AST.
 * Every token — including whitespace-adjacent punctuation like `{`, `,`, `;` —
 * appears as an *anonymous* node.  Tokens that carry semantic meaning (identifiers,
 * keywords used as grammar rules, declarations …) appear as *named* nodes.
 *
 * Extractors should always iterate `node.namedChildren` and look up
 * `node.childForFieldName(fieldName)` to skip anonymous glue tokens and stay
 * grammar-version resilient.
 *
 * Tree-sitter node properties used throughout this pipeline:
 *   node.type              — grammar rule name, e.g. 'import_declaration'
 *   node.text              — raw source slice for this node
 *   node.startPosition.row — 0-indexed line  (add 1 for human-readable output)
 *   node.startPosition.col — 0-indexed column
 *   node.namedChildren     — array of semantically meaningful children
 *   node.children          — array of ALL children (named + anonymous)
 *   node.childForFieldName — get child by grammar field name
 *   node.parent            — parent SyntaxNode (null at root)
 */
class TreeSitterParser extends IParser {
  constructor() {
    super();
    /** @type {import('tree-sitter')} */
    this._parser = new TreeSitter();
    this._parser.setLanguage(JavaScript);
  }

  /** @returns {string[]} */
  getSupportedExtensions() {
    return ['.js', '.jsx'];
  }

  /**
   * @param   {string} filePath
   * @returns {import('./IParser').ParseResult}
   */
  parse(filePath) {
    const sourceCode = fs.readFileSync(filePath, 'utf8');
    const tree       = this._parser.parse(sourceCode);

    return {
      filePath,
      language:   'javascript',
      sourceCode,
      tree,
    };
  }
}

module.exports = TreeSitterParser;
