'use strict';

const neo4j      = require('neo4j-driver');
const IGraphWriter = require('./IGraphWriter');

/**
 * Neo4jGraphWriter — Loads a property graph into Neo4j via Bolt.
 *
 * ─── Strategy ────────────────────────────────────────────────────────────
 * Uses MERGE (find-or-create) throughout, making the loader fully idempotent.
 * Re-running after a re-parse updates properties without creating duplicates.
 *
 * ─── Two-pass ordering ───────────────────────────────────────────────────
 * Pass 1: MERGE all nodes.
 * Pass 2: MERGE all relationships.
 * Nodes must exist before edges reference them.
 *
 * ─── Batching ────────────────────────────────────────────────────────────
 * Large UNWIND batches are used instead of one Cypher per node/edge.
 * Default batch size: 500.  Tune via constructor options if needed.
 *
 * ─── Constraints / Indexes ───────────────────────────────────────────────
 * The writer creates uniqueness constraints on :FILE(id), :FUNCTION(id), etc.
 * on first run.  Safe to run again — uses IF NOT EXISTS.
 */
class Neo4jGraphWriter extends IGraphWriter {
  /**
   * @param {{ uri: string, username: string, password: string, database: string }} config
   * @param {{ batchSize?: number }} [options]
   */
  constructor(config, options = {}) {
    super();
    this._driver    = neo4j.driver(
      config.uri,
      neo4j.auth.basic(config.username, config.password),
    );
    this._database  = config.database ?? 'neo4j';
    this._batchSize = options.batchSize ?? 500;
  }

  /** @returns {Promise<void>} */
  async close() {
    await this._driver.close();
  }

  /**
   * @param {{ nodes: object[], edges: object[] }} graphData
   */
  async write({ nodes, edges }) {
    const session = this._driver.session({ database: this._database });
    try {
      await this._ensureConstraints(session);
      await this._writeNodes(session, nodes);
      await this._writeEdges(session, edges);
    } finally {
      await session.close();
    }
  }

  // ── private ────────────────────────────────────────────────────────────

  async _ensureConstraints(session) {
    const labels = ['FILE', 'FUNCTION', 'COMPONENT', 'CLASS', 'MODULE', 'ROUTE'];
    console.log('[Neo4j] Ensuring constraints…');
    for (const label of labels) {
      await session.run(
        `CREATE CONSTRAINT IF NOT EXISTS FOR (n:${label}) REQUIRE n.id IS UNIQUE`
      );
    }
  }

  async _writeNodes(session, nodes) {
    // Group nodes by label so each batch is a single label (simpler MERGE).
    const byLabel = new Map();
    for (const node of nodes) {
      if (!byLabel.has(node.label)) byLabel.set(node.label, []);
      byLabel.get(node.label).push(node.props);
    }

    for (const [label, props] of byLabel) {
      const batches = chunk(props, this._batchSize);
      console.log(`[Neo4j] Writing ${props.length} :${label} nodes (${batches.length} batch(es))…`);
      for (const batch of batches) {
        await session.run(
          `UNWIND $batch AS props
           MERGE (n:${label} {id: props.id})
           SET n += props`,
          { batch }
        );
      }
    }
  }

  async _writeEdges(session, edges) {
    // Group edges by type.
    const byType = new Map();
    for (const edge of edges) {
      if (!byType.has(edge.type)) byType.set(edge.type, []);
      byType.get(edge.type).push(edge);
    }

    for (const [type, edgeList] of byType) {
      const batches = chunk(edgeList, this._batchSize);
      console.log(`[Neo4j] Writing ${edgeList.length} :${type} edges (${batches.length} batch(es))…`);
      for (const batch of batches) {
        // We look up both ends by their id property (guaranteed unique by constraint).
        // The ANY label wildcard `(a)` works because every node has a unique id.
        await session.run(
          `UNWIND $batch AS e
           MATCH (a {id: e.fromId})
           MATCH (b {id: e.toId})
           MERGE (a)-[r:${type}]->(b)
           SET r += e.props`,
          { batch }
        );
      }
    }
  }
}

/**
 * Split an array into chunks of at most `size`.
 * @param {any[]} arr
 * @param {number} size
 * @returns {any[][]}
 */
function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

module.exports = Neo4jGraphWriter;
