'use strict';

/**
 * IParser — Abstract contract for language parsers.
 *
 * Every language-specific parser must implement this interface.
 * The rest of the pipeline (walker, extractors, writer) never imports a
 * concrete parser directly — they program against IParser.  This is the
 * seam that lets you add TypeScript, Java, Go, or Python support later
 * by creating one new file and registering it in ParserRegistry.
 *
 * SOLID relevance
 *   • Single Responsibility  — only responsible for turning a file into a ParseResult.
 *   • Open/Closed            — pipeline is open for new languages, closed to modification.
 *   • Dependency Inversion   — consumers depend on this abstraction, not on tree-sitter.
 */
class IParser {
  /**
   * Parse a source file and return a language-agnostic ParseResult.
   *
   * @param   {string}      filePath  Absolute path to the source file.
   * @returns {ParseResult}
   * @throws  {Error}       If the file cannot be read or parsed.
   */
  parse(filePath) { // eslint-disable-line no-unused-vars
    throw new Error(`${this.constructor.name} must implement parse(filePath)`);
  }

  /**
   * File extensions handled by this parser (lower-case, with leading dot).
   * ParserRegistry calls this to build its extension → parser map.
   *
   * @returns {string[]}  e.g. ['.js', '.jsx']
   */
  getSupportedExtensions() {
    throw new Error(`${this.constructor.name} must implement getSupportedExtensions()`);
  }
}

/**
 * @typedef  {Object} ParseResult
 * @property {string} filePath    Absolute path to the source file.
 * @property {string} language    Canonical language name ('javascript', 'typescript', …).
 * @property {string} sourceCode  Raw UTF-8 source text.
 * @property {*}      tree        Language-specific AST root.
 *                                For Tree-sitter parsers this is a Tree object whose
 *                                rootNode is a SyntaxNode.
 *
 * The `tree` field is intentionally typed as `*` here so that IParser stays
 * language-agnostic.  Concrete walkers cast it to whatever structure they expect.
 */

module.exports = IParser;
