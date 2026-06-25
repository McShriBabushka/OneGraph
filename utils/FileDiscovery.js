'use strict';

const fs   = require('fs').promises;
const path = require('path');

/**
 * FileDiscovery — Recursively collect source files by extension.
 *
 * Deliberately a standalone utility, not part of the parser or pipeline
 * classes.  Keeping file-system traversal separate means you can later
 * replace it with a git-tree walker (only files changed in a PR), a glob
 * library, or an inotify-based watch-mode emitter — without touching the
 * pipeline or parsers.
 *
 * Skips:
 *   • Dotfile / hidden directories  (.git, .cache, …)
 *   • node_modules, dist, build, coverage, .next, .out
 *
 * These exclusions are conservative defaults suitable for a React monorepo.
 * Pass a custom exclusion set via the constructor for other project shapes.
 */
class FileDiscovery {
  /**
   * @param {string[]} extensions    Lowercase, with leading dot: ['.js', '.jsx'].
   * @param {Set<string>} [excludes] Directory names to skip (base name only).
   */
  constructor(extensions, excludes) {
    this._extensions = new Set(extensions.map(e => e.toLowerCase()));
    this._excludes   = excludes ?? new Set([
      'node_modules', 'dist', 'build', 'coverage', '.next', 'out', '__tests__',
    ]);
  }

  /**
   * Walk rootDir recursively and return absolute paths of all matching files.
   *
   * @param  {string}   rootDir  Absolute path to the directory to walk.
   * @returns {Promise<string[]>}
   */
  async discover(rootDir) {
    const results = [];
    await this._walk(rootDir, results);
    return results;
  }

  // ── private ────────────────────────────────────────────────────────────

  async _walk(dir, results) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return; // silently skip unreadable directories (permission errors, etc.)
    }

    for (const entry of entries) {
      // Skip hidden directories and known noise folders.
      if (entry.name.startsWith('.') || this._excludes.has(entry.name)) continue;

      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        await this._walk(fullPath, results);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (this._extensions.has(ext)) {
          results.push(fullPath);
        }
      }
    }
  }
}

module.exports = FileDiscovery;
