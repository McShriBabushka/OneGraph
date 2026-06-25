'use strict';

const IASTWalker = require('./IASTWalker');

/**
 * TreeSitterWalker — Depth-first CST traversal with O(1) extractor dispatch.
 *
 * ─── Dispatch table design ────────────────────────────────────────────────
 * On construction, the walker asks every extractor which node types it cares
 * about and builds a Map<nodeType, IExtractor[]>.  During traversal, each node
 * is looked up in O(1).  Only extractors registered for that type are called.
 *
 * This avoids a monolithic switch/if-chain that would grow with every new
 * extractor.  Adding an extractor = registering it at the call site in
 * index.js.  The walker never changes.  (Open/Closed Principle.)
 *
 * ─── Why depth-first? ────────────────────────────────────────────────────
 * Tree-sitter CSTs are nested containment trees.  A function contains a body
 * which contains statements which contain expressions.  Depth-first pre-order
 * visits a node before its children, which lets extractors look *upward* at
 * node.parent for context (e.g. arrow function → find variable name in parent).
 *
 * ─── Extractor result accumulation ──────────────────────────────────────
 * Each extractor declares a `factKey` ('imports', 'functions', …).  The walker
 * merges results into a FileFacts object keyed by factKey.  Later, when we add
 * a JsxExtractor, its factKey 'jsxUsages' automatically appears in the output
 * with no changes to this file.
 */
class TreeSitterWalker extends IASTWalker {
  /**
   * @param {import('../extractors/IExtractor')[]} extractors
   *   All extractors for this pipeline run.  Order within the same node type
   *   follows insertion order (standard Map behaviour).
   */
  constructor(extractors) {
    super();

    /**
     * dispatch table: nodeType → [extractor, ...]
     * @type {Map<string, import('../extractors/IExtractor')[]>}
     */
    this._dispatch = new Map();

    for (const extractor of extractors) {
      for (const nodeType of extractor.getNodeTypes()) {
        if (!this._dispatch.has(nodeType)) {
          this._dispatch.set(nodeType, []);
        }
        this._dispatch.get(nodeType).push(extractor);
      }
    }
  }

  /**
   * Entry point: walk the CST and return a FileFacts object.
   *
   * @param   {import('../parser/IParser').ParseResult} parseResult
   * @returns {import('./IASTWalker').FileFacts}
   */
  walk(parseResult) {
    /** @type {import('./IASTWalker').FileFacts} */
    const facts = {
      file:      parseResult.filePath,
      imports:   [],
      exports:   [],
      functions: [],
      calls:     [],
      classes:   [],
    };

    this._visit(parseResult.tree.rootNode, parseResult, facts);
    return facts;
  }

  // ── private ──────────────────────────────────────────────────────────────

  /**
   * Visit a single node, dispatch to interested extractors, then recurse.
   *
   * @param {object}  node         Tree-sitter SyntaxNode.
   * @param {import('../parser/IParser').ParseResult}  parseResult
   * @param {import('./IASTWalker').FileFacts}          facts
   */
  _visit(node, parseResult, facts) {
    const interested = this._dispatch.get(node.type);
    if (interested) {
      for (const extractor of interested) {
        const fact = extractor.extract(node, parseResult);
        if (fact !== null && fact !== undefined) {
          const key = extractor.getFactKey();
          // Gracefully handle extractors whose factKey was not pre-seeded
          if (!Array.isArray(facts[key])) {
            facts[key] = [];
          }
          facts[key].push(fact);
        }
      }
    }

    // Recurse into ALL children (named + anonymous).
    // We visit anonymous nodes too so extractors registered on, e.g.,
    // 'jsx_self_closing_element' (which is a named node inside an expression)
    // are never missed.
    for (let i = 0; i < node.childCount; i++) {
      this._visit(node.child(i), parseResult, facts);
    }
  }
}

module.exports = TreeSitterWalker;
