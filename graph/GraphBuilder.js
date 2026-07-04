'use strict';

const path = require('path');

/**
 * GraphBuilder — Pure data transformation: FileFacts[] → { nodes[], edges[] }.
 *
 * No Neo4j, no file-system, no Tree-sitter.  Takes the JSON produced by Stage 1
 * and produces two flat arrays that any IGraphWriter can persist.
 *
 * ─── Node labels produced ────────────────────────────────────────────────
 *   FILE       — every source file
 *   FUNCTION   — named function / arrow function / method
 *   COMPONENT  — React component (function whose name starts uppercase)
 *   CLASS      — class declaration
 *   MODULE     — external npm package (react, express, …)
 *   ROUTE      — HTTP endpoint (Express route registration)
 *
 * ─── Relationship types produced ─────────────────────────────────────────
 *   CONTAINS    FILE  → FUNCTION | COMPONENT | CLASS | ROUTE
 *   IMPORTS     FILE  → FILE | MODULE
 *   CALLS       FUNCTION | COMPONENT → FUNCTION | COMPONENT
 *   RENDERS     COMPONENT → COMPONENT  (JSX usage)
 *   EXTENDS     CLASS → CLASS
 *   REGISTERS   FILE  → ROUTE
 *   HANDLED_BY  ROUTE → FUNCTION | COMPONENT
 *
 * ─── Node identity ───────────────────────────────────────────────────────
 *   FILE:      file:{absolutePath}
 *   FUNCTION:  fn:{absolutePath}:{name}:{startLine}
 *   CLASS:     class:{absolutePath}:{name}
 *   MODULE:    module:{packageName}
 *   ROUTE:     route:{absolutePath}:{HTTP_METHOD}:{path}
 */
class GraphBuilder {
  /**
   * @param {string} [displayRoot]
   *   Optional prefix to strip from absolute paths for human-readable labels.
   *   Does NOT affect node IDs.
   */
  constructor(displayRoot) {
    this._displayRoot = displayRoot ? path.resolve(displayRoot) : null;
  }

  /**
   * @param   {import('../walker/IASTWalker').FileFacts[]} allFacts
   * @returns {{ nodes: object[], edges: object[] }}
   */
  build(allFacts) {
    /** @type {Map<string, object>} id → node */
    const nodes = new Map();
    /** @type {Map<string, object>} key → edge */
    const edges = new Map();

    const addNode = (node) => {
      if (!nodes.has(node.id)) nodes.set(node.id, node);
    };

    const addEdge = (edge) => {
      const key = `${edge.fromId}||${edge.toId}||${edge.type}`;
      if (!edges.has(key)) edges.set(key, edge);
    };

    // ── Pre-compute import resolution index ───────────────────────────────
    const importMap  = new Map();   // filePath → [{ ...imp, resolvedAbsPath }]
    const knownFiles = new Set(allFacts.map(f => f.file));
    const fileByPath = new Map(allFacts.map(f => [f.file, f]));

    for (const f of allFacts) {
      const resolved = [];
      for (const imp of f.imports) {
        if (!imp.source) continue;
        const resolvedAbsPath = imp.source.startsWith('.')
          ? path.resolve(path.dirname(f.file), imp.source)
          : null;
        resolved.push({ ...imp, resolvedAbsPath });
      }
      importMap.set(f.file, resolved);
    }

    // ── Pass 1: Nodes + containment edges ─────────────────────────────────

    for (const f of allFacts) {
      const fileId = `file:${f.file}`;

      // FILE node
      addNode({
        id:    fileId,
        label: 'FILE',
        props: {
          id:           fileId,
          name:         path.basename(f.file),
          path:         this._rel(f.file),
          absolutePath: f.file,
          ext:          path.extname(f.file),
        },
      });

      // FUNCTION / COMPONENT nodes
      for (const fn of f.functions) {
        if (!fn.name) continue;
        const fnId  = `fn:${f.file}:${fn.name}:${fn.line}`;
        const label = fn.isReactComponent ? 'COMPONENT' : 'FUNCTION';
        addNode({
          id:    fnId,
          label,
          props: {
            id:               fnId,
            name:             fn.name,
            file:             this._rel(f.file),
            absolutePath:     f.file,
            startLine:        fn.line,
            endLine:          fn.endLine ?? fn.line,
            subtype:          fn.subtype ?? null,
            isReactComponent: fn.isReactComponent ?? false,
          },
        });
        addEdge({ fromId: fileId, toId: fnId, type: 'CONTAINS', props: {} });
      }

      // CLASS nodes
      for (const cls of f.classes) {
        if (!cls.name) continue;
        const clsId = `class:${f.file}:${cls.name}`;
        addNode({
          id:    clsId,
          label: 'CLASS',
          props: {
            id:           clsId,
            name:         cls.name,
            file:         this._rel(f.file),
            absolutePath: f.file,
            startLine:    cls.line,
            endLine:      cls.endLine ?? cls.line,
            superClass:   cls.extends ?? null,
          },
        });
        addEdge({ fromId: fileId, toId: clsId, type: 'CONTAINS', props: {} });
      }

      // ROUTE nodes
      for (const route of (f.routes ?? [])) {
        if (!route.httpMethod) continue;
        const routePath = route.path ?? '*';
        const routeId   = `route:${f.file}:${route.httpMethod}:${routePath}`;
        addNode({
          id:    routeId,
          label: 'ROUTE',
          props: {
            id:           routeId,
            httpMethod:   route.httpMethod,
            path:         routePath,
            file:         this._rel(f.file),
            absolutePath: f.file,
            startLine:    route.line,
            endLine:      route.endLine ?? route.line,
          },
        });
        addEdge({ fromId: fileId, toId: routeId, type: 'REGISTERS', props: {} });
      }
    }

    // ── MODULE nodes + IMPORTS edges ──────────────────────────────────────

    for (const f of allFacts) {
      const fileId  = `file:${f.file}`;
      const imports = importMap.get(f.file) ?? [];

      for (const imp of imports) {
        const resolvedFile = this._resolveToKnownFile(imp.resolvedAbsPath, knownFiles);

        if (resolvedFile) {
          addEdge({
            fromId: fileId,
            toId:   `file:${resolvedFile}`,
            type:   'IMPORTS',
            props:  {
              specifiers: imp.specifiers.map(s => s.name).join(','),
              kind:       imp.kind ?? 'esm',
              line:       imp.line,
            },
          });
        } else if (imp.source && !imp.source.startsWith('.')) {
          const moduleId = `module:${imp.source}`;
          addNode({
            id:    moduleId,
            label: 'MODULE',
            props: { id: moduleId, name: imp.source, isExternal: true },
          });
          addEdge({
            fromId: fileId,
            toId:   moduleId,
            type:   'IMPORTS',
            props:  {
              specifiers: imp.specifiers.map(s => s.name).join(','),
              kind:       imp.kind ?? 'esm',
              line:       imp.line,
            },
          });
        }
      }
    }

    // ── Pass 2: Cross-file edges ──────────────────────────────────────────

    // CLASS name → classId index for EXTENDS
    const classIndex = new Map();
    for (const [id, node] of nodes) {
      if (node.label === 'CLASS' && !classIndex.has(node.props.name)) {
        classIndex.set(node.props.name, id);
      }
    }

    for (const f of allFacts) {
      const imports = importMap.get(f.file) ?? [];

      // local binding → resolved file (null = external)
      const localBindings = new Map();
      for (const imp of imports) {
        const resolvedFile = this._resolveToKnownFile(imp.resolvedAbsPath, knownFiles);
        for (const spec of imp.specifiers) {
          localBindings.set(spec.name, resolvedFile ?? null);
        }
      }

      // local function name → fact (same-file calls)
      const localFnMap = new Map();
      for (const fn of f.functions) {
        if (fn.name) localFnMap.set(fn.name, fn);
      }

      // CALLS + RENDERS
      for (const fn of f.functions) {
        if (!fn.name) continue;
        const fnId  = `fn:${f.file}:${fn.name}:${fn.line}`;
        const fnEnd = fn.endLine ?? fn.line + 100000;

        // Only calls whose line falls within this function's body
        const callsInScope = f.calls.filter(c => c.line >= fn.line && c.line <= fnEnd);

        for (const call of callsInScope) {
          if (!call.callee) continue;

          if (call.callType === 'jsx_component') {
            // RENDERS: Component → Component
            const targetFile = localBindings.get(call.callee);
            if (targetFile) {
              const targetFn = fileByPath.get(targetFile)?.functions
                               .find(f2 => f2.name === call.callee);
              if (targetFn) {
                addEdge({
                  fromId: fnId,
                  toId:   `fn:${targetFile}:${targetFn.name}:${targetFn.line}`,
                  type:   'RENDERS',
                  props:  { line: call.line },
                });
              }
            }
            continue;
          }

          if (['function', 'method', 'chained'].includes(call.callType)) {
            const bindingName = call.object ?? call.callee;
            const targetFile  = localBindings.get(bindingName) ?? null;

            if (targetFile) {
              // Cross-file CALLS
              const targetFn = fileByPath.get(targetFile)?.functions
                               .find(f2 => f2.name === call.callee);
              if (targetFn) {
                addEdge({
                  fromId: fnId,
                  toId:   `fn:${targetFile}:${targetFn.name}:${targetFn.line}`,
                  type:   'CALLS',
                  props:  { line: call.line, resolved: true },
                });
              }
            } else if (!call.object) {
              // Same-file CALLS (bare function call, no object)
              const targetFn = localFnMap.get(call.callee);
              if (targetFn && targetFn.line !== fn.line) {
                addEdge({
                  fromId: fnId,
                  toId:   `fn:${f.file}:${targetFn.name}:${targetFn.line}`,
                  type:   'CALLS',
                  props:  { line: call.line, resolved: true },
                });
              }
            }
          }
        }
      }

      // HANDLED_BY: ROUTE → FUNCTION
      for (const route of (f.routes ?? [])) {
        if (!route.httpMethod) continue;
        const routeId = `route:${f.file}:${route.httpMethod}:${route.path ?? '*'}`;

        for (const handler of (route.handlers ?? [])) {
          let targetFn   = null;
          let targetFile = null;

          if (handler.kind === 'method' && handler.object && handler.name) {
            targetFile = localBindings.get(handler.object) ?? null;
            if (targetFile) {
              targetFn = fileByPath.get(targetFile)?.functions
                         .find(f2 => f2.name === handler.name) ?? null;
            }
          } else if (handler.kind === 'function' && handler.name) {
            targetFile = f.file;
            targetFn   = localFnMap.get(handler.name) ?? null;
          }

          if (targetFn && targetFile) {
            addEdge({
              fromId: routeId,
              toId:   `fn:${targetFile}:${targetFn.name}:${targetFn.line}`,
              type:   'HANDLED_BY',
              props:  {},
            });
          }
        }
      }

      // EXTENDS: CLASS → CLASS
      for (const cls of f.classes) {
        if (!cls.name || !cls.extends) continue;
        const fromId   = `class:${f.file}:${cls.name}`;
        const targetId = classIndex.get(cls.extends);
        if (targetId && targetId !== fromId) {
          addEdge({ fromId, toId: targetId, type: 'EXTENDS', props: {} });
        }
      }
    }

    return {
      nodes: [...nodes.values()],
      edges: [...edges.values()],
    };
  }

  // ── private ────────────────────────────────────────────────────────────

  _rel(absolutePath) {
    if (this._displayRoot && absolutePath.startsWith(this._displayRoot)) {
      return absolutePath.slice(this._displayRoot.length).replace(/^\//, '');
    }
    return absolutePath;
  }

  _resolveToKnownFile(resolvedBase, knownFiles) {
    if (!resolvedBase) return null;
    if (knownFiles.has(resolvedBase)) return resolvedBase;
    for (const ext of ['.js', '.jsx', '/index.js', '/index.jsx']) {
      const candidate = resolvedBase + ext;
      if (knownFiles.has(candidate)) return candidate;
    }
    return null;
  }
}

module.exports = GraphBuilder;
