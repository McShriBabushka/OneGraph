'use strict';

const path = require('path');

/**
 * ParserRegistry — Maps file extensions to IParser implementations.
 *
 * This is the sole place that couples a file extension to a parser.
 * The pipeline never hard-codes ".js → TreeSitterParser"; it asks the
 * registry.  Adding TypeScript support means calling .register() with a
 * TypeScriptParser instance — nothing else changes.
 *
 * Usage:
 *   const registry = new ParserRegistry()
 *     .register(new TreeSitterParser())
 *     .register(new TypeScriptParser());   // future
 *
 *   const parser = registry.getParserFor('/src/page.tsx');
 */
class ParserRegistry {
  constructor() {
    /** @type {Map<string, import('./IParser')>} */
    this._registry = new Map();
  }

  /**
   * Register a parser for all extensions it declares.
   * Later registrations for the same extension overwrite earlier ones,
   * enabling targeted overrides (e.g. prefer a TSX-aware parser for .tsx).
   *
   * @param   {import('./IParser')} parser
   * @returns {this}  Fluent — supports chaining.
   */
  register(parser) {
    for (const ext of parser.getSupportedExtensions()) {
      this._registry.set(ext.toLowerCase(), parser);
    }
    return this;
  }

  /**
   * Look up the parser for a given file path by its extension.
   *
   * @param   {string}                   filePath
   * @returns {import('./IParser')|null}  null when no parser is registered.
   */
  getParserFor(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    return this._registry.get(ext) ?? null;
  }

  /**
   * All extensions currently registered.
   * @returns {string[]}
   */
  registeredExtensions() {
    return [...this._registry.keys()];
  }
}

module.exports = ParserRegistry;
