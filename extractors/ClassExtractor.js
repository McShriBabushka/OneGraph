'use strict';

const IExtractor = require('./IExtractor');

/**
 * ClassExtractor — Extracts `class_declaration` nodes.
 *
 * ─── Why `class_declaration`? ────────────────────────────────────────────
 * Class declarations are first-class architectural symbols: they encapsulate
 * state, define service boundaries (e.g. LoanService, ApiClient), and are
 * the primary unit of object-oriented design in JS codebases.
 *
 * We also capture `class_expression` (anonymous class assigned to a variable)
 * via the same parent-variable resolution used by FunctionExtractor.
 *
 * ─── Graph meaning ───────────────────────────────────────────────────────
 *   (Class: LoanService) -[:EXTENDS]-> (Class: BaseService)
 *   (Class: LoanService) -[:HAS_METHOD]-> (Method: fetchLoan)
 *
 * ─── CST structure ───────────────────────────────────────────────────────
 *
 *   class LoanService extends BaseService {
 *     constructor(client) { … }
 *     async fetchLoan(id) { … }
 *   }
 *   ──────────────────────────────────────────────────
 *   class_declaration
 *     identifier               "LoanService"     ← field: 'name'
 *     class_heritage                              ← named child (no field)
 *       identifier             "BaseService"
 *     class_body                                  ← field: 'body'
 *       method_definition
 *         property_identifier  "constructor"
 *         …
 *       method_definition
 *         property_identifier  "fetchLoan"
 *         …
 *
 *   Note: `class_heritage` is a direct named child of class_declaration.
 *   Tree-sitter-javascript does not assign a field name to it; we find it
 *   by type search.
 */
class ClassExtractor extends IExtractor {
  /** @returns {string[]} */
  getNodeTypes() {
    return ['class_declaration', 'class_expression'];
  }

  /** @returns {string} */
  getFactKey() {
    return 'classes';
  }

  /**
   * @param   {object} node  class_declaration or class_expression SyntaxNode
   * @returns {object|null}
   */
  extract(node) {
    // ── Class name ────────────────────────────────────────────────────────
    let name = null;
    if (node.type === 'class_declaration') {
      const nameNode = node.childForFieldName('name') ||
                       node.namedChildren.find(n => n.type === 'identifier');
      name = nameNode?.text ?? null;
    } else {
      // class_expression: name is optional; fall back to variable binding.
      const nameNode = node.childForFieldName('name') ||
                       node.namedChildren.find(n => n.type === 'identifier');
      name = nameNode?.text ?? resolveVariableName(node);
    }

    // ── Superclass (extends) ──────────────────────────────────────────────
    // `class_heritage` is a named child that wraps the `extends` keyword and
    // the superclass expression.  It has no dedicated grammar field name, so
    // we find it by type.
    const heritage    = node.namedChildren.find(n => n.type === 'class_heritage');
    const extendsName = heritage
      ? (heritage.namedChildren.find(n =>
          n.type === 'identifier' || n.type === 'member_expression'
        )?.text ?? null)
      : null;

    // ── Methods ───────────────────────────────────────────────────────────
    // class_body → method_definition[]
    // We only capture method names here; FunctionExtractor handles the body.
    const bodyNode = node.childForFieldName('body') ||
                     node.namedChildren.find(n => n.type === 'class_body');

    const methods = [];
    if (bodyNode) {
      for (const child of bodyNode.namedChildren) {
        if (child.type !== 'method_definition') continue;

        const methodNameNode = child.childForFieldName('name') ||
                               child.namedChildren.find(n =>
                                 n.type === 'property_identifier' ||
                                 n.type === 'computed_property_name'
                               );
        if (!methodNameNode) continue;

        // Detect static methods: `static` is an anonymous child keyword
        const isStatic = child.children.some(c => c.type === 'static');

        methods.push({
          name:     methodNameNode.text,
          line:     child.startPosition.row + 1,
          isStatic,
        });
      }
    }

    return {
      line:    node.startPosition.row + 1,
      name,
      extends: extendsName,
      methods,
    };
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

/**
 * For class_expression: resolve the variable name from `const Foo = class {}`.
 * @param {object} node
 * @returns {string|null}
 */
function resolveVariableName(node) {
  const parent = node.parent;
  if (!parent) return null;
  if (parent.type === 'variable_declarator') {
    const nameNode = parent.childForFieldName('name') ||
                     parent.namedChildren.find(n => n.type === 'identifier');
    return nameNode?.text ?? null;
  }
  return null;
}

module.exports = ClassExtractor;
