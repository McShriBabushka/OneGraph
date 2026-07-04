#!/usr/bin/env node
'use strict';

/**
 * load.js — Stage 2 CLI entry point.
 *
 * Reads a facts.json produced by index.js (Stage 1),
 * builds a property graph, and loads it into Neo4j.
 *
 * Usage:
 *   node load.js <facts-json-path> [display-root]
 *
 * Examples:
 *   node load.js ./output/micro-lap-facts.json \
 *     /Users/reeshav.mohapatra/dms-mobile/src/screens/micro-lap
 *
 *   node load.js ./output/backend-facts.json \
 *     /Users/reeshav.mohapatra/Downloads/freechargebiz-dms-backend-d40ba57591ca/src
 *
 * display-root is optional — strips the prefix from path labels in Neo4j Browser.
 * It does NOT affect node IDs (those always use absolute paths).
 *
 * ── Neo4j connection ──────────────────────────────────────────────────────
 * Edit the NEO4J object below to match your Neo4j Desktop instance.
 */

const fs               = require('fs');
const path             = require('path');
const GraphBuilder     = require('./graph/GraphBuilder');
const Neo4jGraphWriter = require('./graph/Neo4jGraphWriter');

// ── Configure your Neo4j connection here ─────────────────────────────────────
const NEO4J = {
  uri:      'neo4j://127.0.0.1:7687',
  username: 'neo4j',
  password: 'creationism',
  database: 'onegraph',
};
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  const [,, factsPath, displayRoot] = process.argv;

  if (!factsPath) {
    console.error('');
    console.error('  Usage:   node load.js <facts-json-path> [display-root]');
    console.error('  Example: node load.js ./output/micro-lap-facts.json');
    console.error('');
    process.exit(1);
  }

  const resolvedFacts       = path.resolve(factsPath);
  const resolvedDisplayRoot = displayRoot ? path.resolve(displayRoot) : null;

  console.log(`[Load] Reading facts from: ${resolvedFacts}`);
  const allFacts = JSON.parse(fs.readFileSync(resolvedFacts, 'utf8'));
  console.log(`[Load] ${allFacts.length} files loaded`);

  console.log('[Load] Building graph…');
  const builder   = new GraphBuilder(resolvedDisplayRoot);
  const graphData = builder.build(allFacts);
  console.log(`[Load] ${graphData.nodes.length} nodes, ${graphData.edges.length} edges`);

  // Print breakdown before writing
  const nodeSummary = {};
  for (const n of graphData.nodes) nodeSummary[n.label] = (nodeSummary[n.label] || 0) + 1;
  const edgeSummary = {};
  for (const e of graphData.edges) edgeSummary[e.type] = (edgeSummary[e.type] || 0) + 1;
  console.log('[Load] Node breakdown:', nodeSummary);
  console.log('[Load] Edge breakdown:', edgeSummary);

  const writer = new Neo4jGraphWriter(NEO4J);
  try {
    await writer.write(graphData);
    console.log('[Load] Done. Open Neo4j Browser at http://localhost:7474');
  } finally {
    await writer.close();
  }
}

main().catch(err => {
  console.error('[Load] Fatal:', err.message);
  process.exit(1);
});
