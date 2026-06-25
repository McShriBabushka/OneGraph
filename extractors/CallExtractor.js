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

    if (calleeNode.type === 'identifier') {
      return {
        line:     node.startPosition.row + 1,
        callType: 'function',
        callee:   calleeNode.text,
        object:   null,
      };
    }

    if (calleeNode.type === 'member_expression') {
      const objNode  = calleeNode.childForFieldName('object')   || calleeNode.namedChildren[0];
      const propNode = calleeNode.childForFieldName('property') || calleeNode.namedChildren[1];

      return {
        line:     node.startPosition.row + 1,
        callType: 'method',
        callee:   propNode?.text ?? null,
        object:   objNode?.text ?? null,
      };
    }

    // Chained call or other callee shape — record the raw text (truncated).
    return {
      line:     node.startPosition.row + 1,
      callType: 'expression',
      callee:   calleeNode.text.slice(0, 120),
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
    return this._jsxFact(openingEl, node.startPosition.row + 1);
  }

  /**
   * jsx_self_closing_element — `<MyComponent />`.
   * The component name is a direct named child of the element itself.
   */
  _fromJsxSelfClosing(node) {
    return this._jsxFact(node, node.startPosition.row + 1);
  }

  /**
   * Shared helper: extract a JSX component fact from an opening element or
   * self-closing element node.  Filters out lowercase intrinsics (<div> etc.).
   *
   * Tree-sitter field `name` on jsx_opening_element / jsx_self_closing_element
   * is an identifier, member_expression, or jsx_namespace_name.
   */
  _jsxFact(elementNode, line) {
    const nameNode = elementNode.childForFieldName('name') ||
                     elementNode.namedChildren.find(n =>
                       n.type === 'identifier' ||
                       n.type === 'member_expression' ||
                       n.type === 'jsx_namespace_name'
                     );
    if (!nameNode) return null;

    const callee = nameNode.text;

    // Skip HTML intrinsics — they start with a lowercase letter.
    if (/^[a-z]/.test(callee)) return null;

    return {
      line,
      callType: 'jsx_component',
      callee,
      object:   null,
    };
  }
}

module.exports = CallExtractor;
