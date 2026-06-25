'use strict';

/**
 * AnalysisPipeline — Orchestrates the four stages of the pipeline.
 *
 *   FileDiscovery
 *       ↓  [string[]] absolute file paths
 *   ParserRegistry.getParserFor(filePath) → IParser
 *       ↓  [ParseResult]
 *   IASTWalker.walk(parseResult)
 *       ↓  [FileFacts]
 *   IFactWriter.write(allFacts, outputPath)
 *
 * Every collaborator is injected via the constructor.  The pipeline itself
 * has no direct knowledge of Tree-sitter, JSON, the file system, or any
 * specific language.  It is a pure orchestrator.  (Dependency Inversion.)
 *
 * Adding a second language means:
 *   1. Register a new IParser in the registry.
 *   2. Add a new FileDiscovery instance or extend the existing one's extensions.
 *   Nothing else changes in this file.
 */
class AnalysisPipeline {
  /**
   * @param {object}                                 deps
   * @param {import('../utils/FileDiscovery')}        deps.discovery
   * @param {import('../parser/ParserRegistry')}      deps.parserRegistry
   * @param {import('../walker/IASTWalker')}          deps.walker
   * @param {import('../output/IFactWriter')}         deps.writer
   */
  constructor({ discovery, parserRegistry, walker, writer }) {
    this._discovery      = discovery;
    this._parserRegistry = parserRegistry;
    this._walker         = walker;
    this._writer         = writer;
  }

  /**
   * Run the full pipeline end-to-end.
   *
   * @param  {string} sourceDir   Absolute path to the repository / folder to analyse.
   * @param  {string} outputPath  Destination for the JSON facts file.
   * @returns {Promise<import('../walker/IASTWalker').FileFacts[]>}
   *          Returns the facts array so callers can do further in-memory processing.
   */
  async run(sourceDir, outputPath) {
    console.log(`[Pipeline] Discovering files in: ${sourceDir}`);
    const files = await this._discovery.discover(sourceDir);
    console.log(`[Pipeline] Found ${files.length} file(s)`);

    const allFacts = [];
    let   parsed   = 0;
    let   skipped  = 0;
    let   errored  = 0;

    for (const filePath of files) {
      const parser = this._parserRegistry.getParserFor(filePath);
      if (!parser) {
        console.warn(`[Pipeline]  SKIP  ${filePath} — no parser registered`);
        skipped++;
        continue;
      }

      try {
        const parseResult = parser.parse(filePath);
        const facts        = this._walker.walk(parseResult);
        allFacts.push(facts);
        parsed++;
      } catch (err) {
        console.error(`[Pipeline]  ERR   ${filePath} — ${err.message}`);
        errored++;
      }
    }

    console.log(
      `[Pipeline] Parsed: ${parsed}  Skipped: ${skipped}  Errors: ${errored}`
    );

    console.log(`[Pipeline] Writing facts → ${outputPath}`);
    await this._writer.write(allFacts, outputPath);
    console.log(`[Pipeline] Done.`);

    return allFacts;
  }
}

module.exports = AnalysisPipeline;
