'use strict';

const IExtractor = require('./IExtractor');

/**
 * CallExtractor — Extracts function calls, method calls, constructor calls,
 *                 and JSX component usages.
 *
 * ─── Node types targeted ─────────────────────────────────────────────────
 *
 *   call_expression
 *     Covers `foo()`, `obj.method()`, `module.sub.fn()`, chained calls.
 *     The `function` field on the node is the callee expression.
 *
 *     Callee shapes:
 *       identifier          → plain function call  `fetchLoan(id)`
 *       member_expression   → method call          `api.post('/loans')`
 *       call_expression     → chained call         `arr.filter(…).map(…)`
 *                             (we capture the outermost expression text)
 *
 *   new_expression
 *     `new LoanService()` — constructor calls.
 *     The `constructor` field gives the class being instantiated.
 *     In the dependency graph this is a CONSTRUCTS edge.
 *
 *   jsx_element
 *     `<LoanForm loanId={id}>…</LoanForm>`.
 *     The opening element carries the component name.
 *     In the dependency graph this is a JSX_USES edge from the parent
 *     component to the referenced component.
 *
 *   jsx_self_closing_element
 *     `<LoanForm loanId={id} />` — same as jsx_element but self-closed.
 *     Name is a direct named child (no separate opening element).
 *
 * ─── Graph meaning ───────────────────────────────────────────────────────
 *   call_expression  → CALLS edge between two FUNCTION / METHOD symbols
 *   new_expression   → CONSTRUCTS edge from function to CLASS symbol
 *   jsx_element      → JSX_USES edge from REACT_COMPONENT to another REACT_COMPONENT
 *
 * ─── What we deliberately skip ───────────────────────────────────────────
 * • JSX intrinsics (`<div>`, `<span>`) — lowercase first letter, filtered out.
 * • Deeply chained member_expression objects — we record only the immediate
 *   object and property to keep the schema predictable.
 */
class CallExtractor extends IExtractor {
  /** @returns {string[]} */
  getNodeTypes() {
    return [
      'call_expression',
      'new_expression',
      'jsx_element',
      'jsx_self_closing_element',
    ];
  }

  /** @returns {string} */
  getFactKey() {
    return 'calls';
  }

  /**
   * @param   {object} node
   * @returns {object|null}
   */
  extract(node) {
    switch (node.type) {
      case 'call_expression':
        return this._fromCallExpression(node);

      case 'new_expression':
        return this._fromNewExpression(node);

      case 'jsx_element':
        return this._fromJsxElement(node);

      case 'jsx_self_closing_element':
        return this._fromJsxSelfClosing(node);

      default:
        return null;
    }
  }

  // ── private ────────────────────────────────────────────────────────────

  /**
   * call_expression — two sub-shapes: plain call vs method call.
   *
   * Tree-sitter field `function` on call_expression is the callee expression.
   * We fall back to the first named child when childForFieldName returns null
   * (grammar version differences).
   */
  _fromCallExpression(node) {
    const calleeNode = node.childForFieldName('function') ||
                       node.namedChildren[0];
    if (!calleeNode) return null;

    // ── Plain function call: foo() ────────────────────────────────────────
    if (calleeNode.type === 'identifier') {
      // require() is owned by ImportExtractor
      if (calleeNode.text === 'require') return null;

      return {
        line:     node.startPosition.row + 1,
        endLine:  node.endPosition.row + 1,
        callType: 'function',
        callee:   calleeNode.text,
        object:   null,
      };
    }

    // ── Method or chained call: obj.method() ─────────────────────────────
    if (calleeNode.type === 'member_expression') {
      const objNode  = calleeNode.childForFieldName('object')   || calleeNode.namedChildren[0];
      const propNode = calleeNode.childForFieldName('property') || calleeNode.namedChildren[1];
      const callee   = propNode?.text ?? null;

      // If the object is a simple identifier, this is a plain method call.
      if (objNode?.type === 'identifier') {
        return {
          line:     node.startPosition.row + 1,
          endLine:  node.endPosition.row + 1,
          callType: 'method',
          callee,
          object:   objNode.text,
        };
      }

      // If the object is itself a call/new/member chain, resolve to root.
      // Examples:
      //   new AppError().setType().setName()  → root: AppError
      //   Joi.string().custom(...)             → root: Joi
      //   res.status(200).json(...)            → root: res
      //   getCollection().find(...)            → root: getCollection
      //   router.get(...).post(...)            → root: router
      if (objNode) {
        const chainRoot = resolveChainRoot(objNode);
        return {
          line:     node.startPosition.row + 1,
          endLine:  node.endPosition.row + 1,
          callType: 'chained',
          callee,
          object:   chainRoot,
        };
      }
    }

    // ── Fallback: any other callee shape ─────────────────────────────────
    return {
      line:     node.startPosition.row + 1,
      endLine:  node.endPosition.row + 1,
      callType: 'expression',
      callee:   calleeNode.text.split('\n')[0].slice(0, 80),
      object:   null,
    };
  }

  /**
   * new_expression — `new Foo(args)`.
   *
   * The `constructor` field holds the class being instantiated.
   */
  _fromNewExpression(node) {
    const ctorNode = node.childForFieldName('constructor') ||
                     node.namedChildren.find(n =>
                       n.type === 'identifier' || n.type === 'member_expression'
                     );
    return {
      line:     node.startPosition.row + 1,
      endLine:  node.endPosition.row + 1,
      callType: 'constructor',
      callee:   ctorNode?.text ?? null,
      object:   null,
    };
  }

  /**
   * jsx_element — `<MyComponent>…</MyComponent>`.
   * The first named child of jsx_opening_element is the component name.
   */
  _fromJsxElement(node) {
    const openingEl = node.namedChildren.find(n => n.type === 'jsx_opening_element');
    if (!openingEl) return null;
    return this._jsxFact(openingEl, node.startPosition.row + 1, node.endPosition.row + 1);
  }

  _fromJsxSelfClosing(node) {
    return this._jsxFact(node, node.startPosition.row + 1, node.endPosition.row + 1);
  }

  /**
   * Shared helper: extract a JSX component fact from an opening element or
   * self-closing element node.  Filters out lowercase intrinsics (<div> etc.).
   *
   * Tree-sitter field `name` on jsx_opening_element / jsx_self_closing_element
   * is an identifier, member_expression, or jsx_namespace_name.
   */
  _jsxFact(elementNode, line, endLine) {
    const nameNode = elementNode.childForFieldName('name') ||
                     elementNode.namedChildren.find(n =>
                       n.type === 'identifier' ||
                       n.type === 'member_expression' ||
                       n.type === 'jsx_namespace_name'
                     );
    if (!nameNode) return null;

    const callee = nameNode.text;
    if (/^[a-z]/.test(callee)) return null;

    return {
      line,
      endLine,
      callType: 'jsx_component',
      callee,
      object:   null,
    };
  }
}

module.exports = CallExtractor;

// ── module-level helpers ──────────────────────────────────────────────────────

/**
 * resolveChainRoot — Walk down a chained expression to find the root identifier.
 *
 * Given any of:
 *   new AppError().setType().setName()   → "AppError"
 *   Joi.string().custom(...)             → "Joi"
 *   res.status(200).json(...)            → "res"
 *   getCollection().find(...)            → "getCollection"
 *   router.get(...).post(...)            → "router"
 *   promise.then(...).catch(...)         → (root of promise)
 *
 * The algorithm: repeatedly unwrap the outermost wrapper node until we reach
 * an identifier or hit a dead end.
 *
 * @param   {object}      node  Any SyntaxNode (the object side of a member_expression)
 * @returns {string|null}
 */
function resolveChainRoot(node) {
  let current = node;
  let depth = 0; // guard against degenerate infinite loops

  while (current && depth < 30) {
    depth++;
    switch (current.type) {
      case 'identifier':
        return current.text;

      // obj.prop  →  keep unwrapping the object side
      case 'member_expression': {
        const obj = current.childForFieldName('object') || current.namedChildren[0];
        current = obj;
        break;
      }

      // fn()  →  unwrap the callee
      case 'call_expression': {
        const callee = current.childForFieldName('function') || current.namedChildren[0];
        current = callee;
        break;
      }

      // new Foo()  →  take the constructor
      case 'new_expression': {
        const ctor = current.childForFieldName('constructor') ||
                     current.namedChildren.find(n =>
                       n.type === 'identifier' || n.type === 'member_expression'
                     );
        current = ctor;
        break;
      }

      // await expr  →  unwrap the awaited expression
      case 'await_expression':
        current = current.namedChildren[0];
        break;

      // parenthesized (...)  →  unwrap
      case 'parenthesized_expression':
        current = current.namedChildren[0];
        break;

      default:
        // Cannot resolve further — return first line of text, truncated
        return current.text?.split('\n')[0]?.slice(0, 60) ?? null;
    }
  }

  return null;
}
