'use strict';

/**
 * IGraphWriter — Abstract contract for writing a property graph to a store.
 *
 * The loader depends only on this interface.  Swapping Neo4j for another store
 * (ArangoDB, Memgraph, a flat GraphML file) means one new class.
 *
 * SOLID: Dependency Inversion — load.js depends on IGraphWriter, not Neo4j.
 */
class IGraphWriter {
  /**
   * @param {{ nodes: object[], edges: object[] }} graphData
   * @returns {Promise<void>}
   */
  async write(graphData) { // eslint-disable-line no-unused-vars
    throw new Error(`${this.constructor.name} must implement write(graphData)`);
  }

  /** Release driver / connection resources. */
  async close() {
    throw new Error(`${this.constructor.name} must implement close()`);
  }
}

module.exports = IGraphWriter;
