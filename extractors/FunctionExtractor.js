'use strict';

const IExtractor = require('./IExtractor');

/**
 * FunctionExtractor — Extracts named function and method definitions.
 *
 * ─── Node types targeted ─────────────────────────────────────────────────
 *
 *   function_declaration
 *     Standard `function foo() {}` at statement level.
 *     Has a `name` field → identifier.
 *     Graph node: FUNCTION symbol exported or private to its file.
 *
 *   function_expression
 *     `const foo = function() {}` or `const foo = function named() {}`.
 *     No intrinsic name; we look upward at node.parent to find the
 *     variable_declarator → identifier that holds it.
 *     Graph node: same as function_declaration once the name is resolved.
 *
 *   arrow_function
 *     `const Foo = (props) => { … }` — the most common React component form.
 *     Arrow functions carry NO name themselves; the name lives in the parent
 *     variable_declarator.  Looking at node.parent is safe in Tree-sitter's
 *     Node.js bindings — the parent property is always populated.
 *     Graph node: FUNCTION or REACT_COMPONENT if name starts with uppercase.
 *
 *   generator_function_declaration
 *     `function* saga() {}` — Redux-saga and similar patterns.
 *     Treated identically to function_declaration.
 *
 *   method_definition
 *     Method inside a class body.
 *     Has a `name` field → property_identifier.
 *     We walk upward to find the enclosing class_declaration for context.
 *     Graph node: METHOD belonging to a CLASS symbol.
 *
 * ─── React component detection ───────────────────────────────────────────
 * React components are distinguished by the convention that their name
 * starts with an uppercase letter.  This is the only reliable heuristic
 * without running the code or doing type inference.
 *
 * ─── What we deliberately skip ───────────────────────────────────────────
 * • Inline/anonymous callbacks (`arr.map(x => x + 1)`) — they return null
 *   because their parent is not a variable_declarator.
 * • Object method shorthand (`{ foo() {} }`) — a future extractor can add
 *   `method_definition` inside `object_expression`.
 */
class FunctionExtractor extends IExtractor {
  /** @returns {string[]} */
  getNodeTypes() {
    return [
      'function_declaration',
      'generator_function_declaration',
      'function_expression',
      'arrow_function',
      'method_definition',
    ];
  }

  /** @returns {string} */
  getFactKey() {
    return 'functions';
  }

  /**
   * @param   {object} node
   * @returns {object|null}
   */
  extract(node) {
    switch (node.type) {
      case 'function_declaration':
      case 'generator_function_declaration':
        return this._fromDeclaration(node);

      case 'function_expression':
        return this._fromParentVariable(node, 'expression');

      case 'arrow_function':
        return this._fromParentVariable(node, 'arrow');

      case 'method_definition':
        return this._fromMethodDef(node);

      default:
        return null;
    }
  }

  // ── private ────────────────────────────────────────────────────────────

  /**
   * `function foo() {}` — name is a direct named child (field: 'name').
   */
  _fromDeclaration(node) {
    const nameNode = node.childForFieldName('name') ||
                     node.namedChildren.find(n => n.type === 'identifier');
    const name     = nameNode?.text ?? null;

    return {
      line:             node.startPosition.row + 1,
      endLine:          node.endPosition.row + 1,
      name,
      subtype:          node.type === 'generator_function_declaration' ? 'generator' : 'declaration',
      isReactComponent: isComponent(name),
    };
  }

  /**
   * `const Foo = function() {}` or `const Foo = () => {}`.
   * Name must be retrieved from the parent variable_declarator.
   * Returns null for anonymous inline callbacks that have no variable binding.
   */
  _fromParentVariable(node, subtype) {
    const name = resolveVariableName(node);
    if (!name) return null;   // skip unnamed inline callbacks

    return {
      line:             node.startPosition.row + 1,
      endLine:          node.endPosition.row + 1,
      name,
      subtype,
      isReactComponent: isComponent(name),
    };
  }

  /**
   * Class method — walks upward to find the enclosing class name.
   *
   * Tree-sitter method_definition structure:
   *   method_definition
   *     property_identifier  "render"      ← field: 'name'
   *     formal_parameters
   *     statement_block
   */
  _fromMethodDef(node) {
    const nameNode  = node.childForFieldName('name') ||
                      node.namedChildren.find(n => n.type === 'property_identifier');
    const name      = nameNode?.text ?? null;
    const parentCls = resolveParentClassName(node);

    return {
      line:             node.startPosition.row + 1,
      endLine:          node.endPosition.row + 1,
      name,
      subtype:          'method',
      parentClass:      parentCls,
      isReactComponent: false,
    };
  }
}

// ── module-level helpers (pure functions, no state) ──────────────────────────

/**
 * Walk up to the nearest variable_declarator and return the binding name.
 * Returns null when the function is an anonymous inline callback.
 *
 * @param {object} node
 * @returns {string|null}
 */
function resolveVariableName(node) {
  const parent = node.parent;
  if (!parent) return null;

  // Direct: const Foo = () => {}
  if (parent.type === 'variable_declarator') {
    const nameNode = parent.childForFieldName('name') ||
                     parent.namedChildren.find(n => n.type === 'identifier');
    return nameNode?.text ?? null;
  }

  // Wrapped: const pickLead = catchAsync.bind(null, async (req, res) => {})
  //   arrow_function  ← node
  //     parent: arguments
  //       parent: call_expression  (catchAsync.bind(...))
  //         parent: variable_declarator  ← holds the name
  if (parent.type === 'arguments') {
    const callExpr = parent.parent;
    if (callExpr?.type === 'call_expression') {
      const declarator = callExpr.parent;
      if (declarator?.type === 'variable_declarator') {
        const nameNode = declarator.childForFieldName('name') ||
                         declarator.namedChildren.find(n => n.type === 'identifier');
        return nameNode?.text ?? null;
      }
    }
  }

  return null;
}

/**
 * Walk up from a method_definition to find the enclosing class name.
 *
 * @param {object} node  method_definition SyntaxNode
 * @returns {string|null}
 */
function resolveParentClassName(node) {
  let cursor = node.parent; // class_body
  while (cursor) {
    if (cursor.type === 'class_declaration' || cursor.type === 'class_expression') {
      const nameNode = cursor.childForFieldName('name') ||
                       cursor.namedChildren.find(n => n.type === 'identifier');
      return nameNode?.text ?? null;
    }
    cursor = cursor.parent;
  }
  return null;
}

/**
 * React component heuristic: name exists and starts with an uppercase letter.
 * @param {string|null} name
 * @returns {boolean}
 */
function isComponent(name) {
  return typeof name === 'string' && /^[A-Z]/.test(name);
}

module.exports = FunctionExtractor;
