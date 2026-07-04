'use strict';

/**
 * dump-cst.js — One-off CST inspector.
 *
 * Prints every NAMED node in the first N lines of a file, showing:
 *   node.type | startLine | text (truncated)
 *
 * Usage:
 *   node debug/dump-cst.js <absolute-file-path> [maxLines]
 *
 * Example:
 *   node debug/dump-cst.js /path/to/AmountInput.js 30
 */

const TreeSitter = require('tree-sitter');
const JavaScript = require('tree-sitter-javascript');
const fs         = require('fs');

const [,, filePath, maxLinesArg] = process.argv;
if (!filePath) {
  console.error('Usage: node debug/dump-cst.js <file-path> [maxLines]');
  process.exit(1);
}

const maxLines  = parseInt(maxLinesArg ?? '999999', 10);
const source    = fs.readFileSync(filePath, 'utf8');
const parser    = new TreeSitter();
parser.setLanguage(JavaScript);
const tree      = parser.parse(source);

console.log(`\nFile: ${filePath}`);
console.log(`Showing named nodes up to line ${maxLines}\n`);
console.log('TYPE'.padEnd(45) + 'LINE'.padEnd(8) + 'TEXT (first 80 chars)');
console.log('─'.repeat(110));

function visit(node) {
  if (node.startPosition.row >= maxLines) return;

  if (node.isNamed) {
    const type = node.type.padEnd(45);
    const line = String(node.startPosition.row + 1).padEnd(8);
    const text = node.text.replace(/\n/g, '↵').slice(0, 80);
    console.log(`${type}${line}${text}`);
  }

  for (let i = 0; i < node.childCount; i++) {
    visit(node.child(i));
  }
}

visit(tree.rootNode);
