'use strict';

/**
 * IASTWalker — Abstract contract for AST traversal strategies.
 *
 * Separating *traversal* from *extraction* is a key architectural decision.
 * The walker owns "how do we visit every node"; extractors own "what does
 * this node mean".  You can change traversal strategy (depth-first → scope-
 * aware → parallel) without touching any extractor.
 *
 * Concretely:
 *   TreeSitterWalker  — depth-first, dispatch-table driven (current)
 *   ScopeAwareWalker  — tracks variable scopes, future enhancement
 *   TypeAwareWalker   — integrates type inference, future enhancement
 *
 * SOLID relevance
 *   • Single Responsibility — only responsible for traversal, not interpretation.
 *   • Dependency Inversion  — pipeline programs against IASTWalker.
 */
class IASTWalker {
  /**
   * Walk the entire AST in parseResult and return all extracted facts.
   *
   * Extractors are baked into the walker at construction time (see
   * TreeSitterWalker).  The pipeline passes a pre-configured walker
   * instance, so this method only needs the parse result.
   *
   * @param   {import('../parser/IParser').ParseResult} parseResult
   * @returns {FileFacts}
   */
  walk(parseResult) { // eslint-disable-line no-unused-vars
    throw new Error(`${this.constructor.name} must implement walk(parseResult)`);
  }
}

/**
 * @typedef  {Object}   FileFacts
 * @property {string}   file       Absolute path to the source file.
 * @property {object[]} imports    Facts produced by ImportExtractor.
 * @property {object[]} exports    Facts produced by ExportExtractor.
 * @property {object[]} functions  Facts produced by FunctionExtractor.
 * @property {object[]} calls      Facts produced by CallExtractor.
 * @property {object[]} classes    Facts produced by ClassExtractor.
 *
 * In the future dependency graph each FileFacts becomes a FILE node,
 * and individual facts become SYMBOL nodes or labelled edges.
 */

module.exports = IASTWalker;
