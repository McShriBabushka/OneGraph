#!/usr/bin/env node
'use strict';

/**
 * index.js — CLI entry point and dependency-injection root.
 *
 * This file is the ONLY place that imports concrete implementations.
 * Every other module in this project imports interfaces or abstract classes.
 * Wiring happens here and is clearly separated from business logic.
 *
 * Usage:
 *   node index.js <source-directory> [output-path]
 *
 * Examples:
 *   node index.js ./my-react-repo
 *   node index.js /abs/path/to/repo ./output/facts.json
 *   node index.js /abs/path/to/repo ./output/loan-journey.json
 */

const path = require('path');

// ── Concrete implementations (injected at the root) ──────────────────────────

const TreeSitterParser  = require('./parser/TreeSitterParser');
const ParserRegistry    = require('./parser/ParserRegistry');

const TreeSitterWalker  = require('./walker/TreeSitterWalker');

const ImportExtractor   = require('./extractors/ImportExtractor');
const ExportExtractor   = require('./extractors/ExportExtractor');
const FunctionExtractor = require('./extractors/FunctionExtractor');
const CallExtractor     = require('./extractors/CallExtractor');
const ClassExtractor    = require('./extractors/ClassExtractor');

const JsonFactWriter    = require('./output/JsonFactWriter');

const FileDiscovery     = require('./utils/FileDiscovery');
const AnalysisPipeline  = require('./pipeline/AnalysisPipeline');

// ── Compose the pipeline ──────────────────────────────────────────────────────
//
// To add TypeScript support later:
//   1. Create parser/TypeScriptParser.js implementing IParser.
//   2. Add  registry.register(new TypeScriptParser())
//   3. Extend FileDiscovery extensions to include ['.ts', '.tsx'].
//   No other file changes required.

const extractors = [
  new ImportExtractor(),
  new ExportExtractor(),
  new FunctionExtractor(),
  new CallExtractor(),
  new ClassExtractor(),
  // Future: new TypeAnnotationExtractor(), new HookExtractor(), ...
];

const registry = new ParserRegistry()
  .register(new TreeSitterParser());   // handles .js and .jsx

const walker  = new TreeSitterWalker(extractors);
const writer  = new JsonFactWriter({ indent: 2 });

const discovery = new FileDiscovery(['.js', '.jsx']);

const pipeline = new AnalysisPipeline({
  discovery,
  parserRegistry: registry,
  walker,
  writer,
});

// ── CLI argument parsing ──────────────────────────────────────────────────────

const [,, sourceDir, outputPath] = process.argv;

if (!sourceDir) {
  console.error('');
  console.error('  Usage:   node index.js <source-directory> [output-path]');
  console.error('  Example: node index.js ./my-react-repo ./output/facts.json');
  console.error('');
  process.exit(1);
}

const resolvedSource = path.resolve(sourceDir);
const resolvedOutput = path.resolve(outputPath ?? './output/facts.json');

pipeline.run(resolvedSource, resolvedOutput).catch(err => {
  console.error('[Pipeline] Fatal:', err.message);
  process.exit(1);
});
