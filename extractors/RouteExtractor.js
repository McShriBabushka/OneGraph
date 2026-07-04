'use strict';

const IExtractor = require('./IExtractor');

/**
 * RouteExtractor — Extracts Express route registrations.
 *
 * ─── Why a dedicated extractor? ──────────────────────────────────────────
 * Route registrations are not just function calls — they are structural
 * declarations of the API surface.  A `router.post('/loans', ...handlers)`
 * line tells us:
 *   • What HTTP method and path exist
 *   • Which middlewares gate the endpoint
 *   • Which controller function handles it
 *
 * Generic CallExtractor would only give us `callType:'method', callee:'post',
 * object:'router'` — losing all of that richness.  In the dependency graph,
 * route facts become ROUTE nodes with HANDLED_BY edges to controller functions,
 * enabling queries like "which endpoints are affected if I change pickLead?".
 *
 * ─── Node type targeted ──────────────────────────────────────────────────
 * `call_expression` — same as CallExtractor, but this extractor only fires
 * when the callee is `<routerVar>.get/post/put/delete/patch/use/all`.
 *
 * The walker dispatches ALL call_expression nodes to both CallExtractor and
 * RouteExtractor.  RouteExtractor returns null for non-route calls, so there
 * is no performance cost.
 *
 * ─── CST structure ───────────────────────────────────────────────────────
 *
 *   router.post('/cpv/pick', authMiddleware.verify, controller.pickLead)
 *   ─────────────────────────────────────────────────────────────────────
 *   call_expression
 *     member_expression           ← callee
 *       identifier  "router"      ← router variable name
 *       property_identifier "post"  ← HTTP method
 *     arguments
 *       string          '/cpv/pick'       ← path (first arg)
 *       member_expression  auth.verify    ← middleware
 *       member_expression  controller.pickLead  ← handler
 *
 *   Chained routes (router.get(...).post(...)):
 *   ────────────────────────────────────────────
 *   call_expression            ← outermost (.post)
 *     member_expression
 *       call_expression        ← .get(...) — already its own route node
 *       property_identifier "post"
 *     arguments
 *       ...
 *
 *   Each call_expression in the chain is visited separately by the walker,
 *   so we extract each route independently without needing to unroll chains.
 *
 * ─── Graph meaning ───────────────────────────────────────────────────────
 *   (ROUTE: POST /cpv/pick) -[:GUARDED_BY]-> (FUNCTION: verifyAccessToken)
 *   (ROUTE: POST /cpv/pick) -[:HANDLED_BY]-> (FUNCTION: pickLead)
 *   (FILE: leadRouter.js)   -[:REGISTERS]->  (ROUTE: POST /cpv/pick)
 */
class RouteExtractor extends IExtractor {
  /**
   * HTTP method names we recognise as Express route registrations.
   * `use` and `all` are included because they also register handlers.
   * @type {Set<string>}
   */
  static HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'use', 'all']);

  /** @returns {string[]} */
  getNodeTypes() {
    return ['call_expression'];
  }

  /** @returns {string} */
  getFactKey() {
    return 'routes';
  }

  /**
   * @param   {object} node  call_expression SyntaxNode
   * @returns {object|null}  null for non-route calls
   */
  extract(node) {
    // ── Identify the callee ───────────────────────────────────────────────
    const calleeNode = node.childForFieldName('function') || node.namedChildren[0];
    if (!calleeNode || calleeNode.type !== 'member_expression') return null;

    const methodNode = calleeNode.childForFieldName('property') ||
                       calleeNode.namedChildren.find(n => n.type === 'property_identifier');
    if (!methodNode) return null;

    const httpMethod = methodNode.text.toLowerCase();
    if (!RouteExtractor.HTTP_METHODS.has(httpMethod)) return null;

    // ── Extract arguments ─────────────────────────────────────────────────
    const argsNode = node.namedChildren.find(c => c.type === 'arguments');
    if (!argsNode) return null;

    const args = argsNode.namedChildren; // named children skip the ( ) commas

    // First argument should be the path string (skip for `router.use(middleware)`)
    const firstArg  = args[0];
    const path      = (firstArg?.type === 'string')
      ? (firstArg.namedChildren.find(c => c.type === 'string_fragment')?.text ??
         firstArg.text.replace(/^['"`]|['"`]$/g, ''))
      : null;

    // Remaining args are middlewares / handlers
    const handlerArgs = path !== null ? args.slice(1) : args;
    const handlers    = handlerArgs.map(extractHandlerRef).filter(Boolean);

    // Skip if we couldn't get at least a method (avoids false positives on
    // unrelated .use() calls on non-router objects)
    if (handlers.length === 0 && path === null) return null;

    return {
      line:       node.startPosition.row + 1,
      endLine:    node.endPosition.row + 1,
      httpMethod: httpMethod.toUpperCase(),
      path,
      handlers,
    };
  }
}

// ── helpers ───────────────────────────────────────────────────────────────────

/**
 * Convert a handler argument node into a structured handler reference.
 *
 * Shapes handled:
 *   identifier              → { kind: 'function',  name: 'handleFoo' }
 *   member_expression       → { kind: 'method',    object: 'controller', name: 'pickLead' }
 *   call_expression (.bind) → { kind: 'bound',     object: 'joi', name: 'validate', boundArg: 'schema' }
 *   arrow_function          → { kind: 'inline' }
 *
 * @param   {object}      node
 * @returns {object|null}
 */
function extractHandlerRef(node) {
  switch (node.type) {
    case 'identifier':
      return { kind: 'function', name: node.text };

    case 'member_expression': {
      const obj  = node.childForFieldName('object')   || node.namedChildren[0];
      const prop = node.childForFieldName('property') || node.namedChildren[1];
      if (!obj || !prop) return null;
      return { kind: 'method', object: obj.text, name: prop.text };
    }

    // joiMiddleware.bind(null, validator.pickLead)
    case 'call_expression': {
      const callee = node.childForFieldName('function') || node.namedChildren[0];
      if (!callee || callee.type !== 'member_expression') return null;

      const prop = callee.childForFieldName('property') || callee.namedChildren[1];
      if (prop?.text !== 'bind') return null;

      const obj     = callee.childForFieldName('object') || callee.namedChildren[0];
      const argsN   = node.namedChildren.find(c => c.type === 'arguments');
      // bind(null, schema) — skip null, take the second arg as the bound arg
      const boundArg = argsN?.namedChildren[1];
      return {
        kind:     'bound',
        object:   obj?.text ?? null,
        name:     'bind',
        boundArg: boundArg?.text ?? null,
      };
    }

    case 'arrow_function':
    case 'function_expression':
      return { kind: 'inline' };

    default:
      return null;
  }
}

module.exports = RouteExtractor;
