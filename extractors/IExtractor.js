'use strict';

/**
 * IExtractor — Abstract contract for a single-concern fact extractor.
 *
 * Each extractor is responsible for exactly ONE category of architectural
 * fact.  It declares which Tree-sitter node types it wants to see, and it
 * converts one matching node into a plain-object fact.
 *
 * The walker owns traversal; the extractor owns interpretation.
 * Neither knows about the other's internals.
 *
 * ─── Why per-node-type registration? ────────────────────────────────────
 * Tree-sitter's grammar rule names are precise and stable.  Registering by
 * node type avoids "instanceof" style branching inside a monolithic visitor
 * and lets the walker build an O(1) dispatch table.
 *
 * ─── Future multi-language note ──────────────────────────────────────────
 * A Python ImportExtractor would return the same fact shape but register for
 * `import_statement` (the Python grammar's node type for imports).  The
 * pipeline wires together the right extractors for each language through
 * dependency injection in index.js.
 *
 * SOLID relevance
 *   • Single Responsibility — one class, one fact category.
 *   • Open/Closed           — add an extractor without editing existing ones.
 *   • Dependency Inversion  — TreeSitterWalker depends on IExtractor[], not
 *                             on ImportExtractor or FunctionExtractor directly.
 */
class IExtractor {
  /**
   * The Tree-sitter node type strings this extractor wants to handle.
   * Returned types must exactly match `node.type` values produced by the
   * grammar being used.
   *
   * @returns {string[]}
   */
  getNodeTypes() {
    throw new Error(`${this.constructor.name} must implement getNodeTypes()`);
  }

  /**
   * Extract a single architectural fact from a matching node.
   *
   * Return `null` to tell the walker "nothing interesting here" (e.g. an
   * anonymous inline arrow function that is not assigned to a variable).
   *
   * @param   {object} node        Tree-sitter SyntaxNode whose type is one
   *                               of the values returned by getNodeTypes().
   * @param   {import('../parser/IParser').ParseResult} parseResult
   * @returns {object|null}        Plain-object fact, or null to skip.
   */
  extract(node, parseResult) { // eslint-disable-line no-unused-vars
    throw new Error(`${this.constructor.name} must implement extract(node, parseResult)`);
  }

  /**
   * The key under which this extractor's facts are stored in FileFacts.
   *
   * Naming convention: lowercase plural noun matching the FileFacts property,
   * e.g. 'imports', 'exports', 'functions', 'calls', 'classes'.
   *
   * This key also maps directly to a future Neo4j node label or graph edge
   * category when the pipeline grows into Stage 2.
   *
   * @returns {string}
   */
  getFactKey() {
    throw new Error(`${this.constructor.name} must implement getFactKey()`);
  }
}

module.exports = IExtractor;
