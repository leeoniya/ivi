import { declare } from "@babel/helper-plugin-utils";
import moduleImports from "@babel/helper-module-imports";
import { compileTemplate } from "@ivi/template-compiler";
import { TemplateParserError } from "@ivi/template-compiler/parser";
import { hoistExpr } from "./shared.js";

const ivi = (config) => declare((api) => {
  api.assertVersion(7);
  const t = api.types;

  const templateLanguages = config?.templateLanguages ?? [];

  const getStaticValue = (s) => s.value.cooked;
  const pure = (n) => t.addComment(n, "leading", "@__PURE__");
  const toNumeric = (i) => t.numericLiteral(i);
  const toString = (s) => t.stringLiteral(s);

  function importSymbolFactory(path) {
    const modules = new Map();
    return (moduleName, name) => {
      let symbols = modules.get(moduleName);
      if (!symbols) {
        modules.set(moduleName, (symbols = new Map()));
      }
      let symbolName = symbols.get(name);
      if (!symbolName) {
        symbolName =
          name === "default"
            ? moduleImports.addDefault(path, moduleName)
            : moduleImports.addNamed(path, name, moduleName);
        symbols.set(name, symbolName);
      }
      return symbolName;
    };
  }

  function staticTemplateToExpr(s, exprs) {
    let lastStringLiteral = t.stringLiteral("");
    let result = lastStringLiteral;
    for (const c of s) {
      if (typeof c === "string") {
        lastStringLiteral.value += c;
      } else {
        result = t.binaryExpression(
          "+",
          t.binaryExpression("+", result, exprs[c]),
          (lastStringLiteral = t.stringLiteral(""))
        );
      }
    }
    return result;
  }

  function createTemplateDescriptor(
    importSymbol,
    exprsNodes,
    type,
    clone,
    id,
    root
  ) {
    const template = root.template;
    let factoryFnId;
    let factoryFnArg;
    if (typeof template === "string") {
      factoryFnArg = t.stringLiteral(template);
      if (type === "htm") {
        factoryFnId = "_hE";
      } else {
        factoryFnId = "_sE";
      }
    } else {
      factoryFnArg = staticTemplateToExpr(template, exprsNodes);
      if (type === "htm") {
        if (clone) {
          factoryFnId = "_h";
        } else {
          factoryFnId = "_hN";
        }
      } else {
        if (clone) {
          factoryFnId = "_s";
        } else {
          factoryFnId = "_sN";
        }
      }
    }

    return t.variableDeclaration("const", [
      t.variableDeclarator(
        id,
        t.addComment(
          t.callExpression(importSymbol("ivi", "_T"), [
            t.callExpression(importSymbol("ivi", factoryFnId), [factoryFnArg]),
            t.numericLiteral(root.flags),
            t.arrayExpression(root.props.map(toNumeric)),
            t.arrayExpression(root.child.map(toNumeric)),
            t.arrayExpression(root.state.map(toNumeric)),
            t.arrayExpression(root.data.map(toString)),
          ]),
          "leading",
          "@__PURE__ @__IVI_TPL__"
        )
      ),
    ]);
  }

  function transformRootNode(
    importSymbol,
    path,
    exprsNodes,
    type,
    clone,
    root
  ) {
    switch (root.type) {
      case 0: // Element
        const dynamicExprs = root.exprs.map((e) => exprsNodes[e]);
        const id = path.scope.generateUidIdentifier("__tpl_");
        hoistExpr(
          path,
          createTemplateDescriptor(
            importSymbol,
            exprsNodes,
            type,
            clone,
            id,
            root
          )
        );
        return t.callExpression(
          importSymbol("ivi", "_t"),
          dynamicExprs.length > 0 ? [id, t.arrayExpression(dynamicExprs)] : [id]
        );
      case 1: // Text
        return t.stringLiteral(root.value);
      case 2: // Expr
        return exprsNodes[root.value];
    }
  }

  return {
    name: "ivi",
    visitor: {
      Program: {
        enter(path, state) {
          state.importSymbol = importSymbolFactory(path);
        },
      },

      CallExpression(path) {
        // Add `@__PURE__` comment for `component(() => {..})` exprs.
        if (path.get("callee").referencesImport("ivi", "component")) {
          path.replaceWith(pure(path.node));
        }
      },

      TaggedTemplateExpression: {
        exit(path, state) {
          let type;
          let parse;
          const tag = path.get("tag");
          for (let i = 0; i < templateLanguages.length; i++) {
            const lang = templateLanguages[i];
            if (tag.referencesImport(lang.module, "htm")) {
              type = "htm";
              parse = lang.parse;
              break;
            } else if (tag.referencesImport(lang.module, "svg")) {
              type = "svg";
              parse = lang.parse;
              break;
            }
          }
          if (parse !== void 0) {
            const importSymbol = state.importSymbol;
            const statics = path.node.quasi.quasis.map(getStaticValue);
            const exprs = path.get("quasi").get("expressions");
            const exprsNodes = path.node.quasi.expressions;

            try {
              const leadingComments = path.node.leadingComments;
              let clone = true;
              if (leadingComments) {
                for (const comment of leadingComments) {
                  if (comment.value.trim() === "-c") {
                    clone = false;
                    break;
                  }
                }
              }

              const template = parse(
                statics,
                type === "svg" ? 1 : 0,
                (i) => tryHoistExpr(exprs[i])
              );
              const result = compileTemplate(template);
              const roots = result.roots;
              if (roots.length === 1) {
                path.replaceWith(
                  transformRootNode(
                    importSymbol,
                    path,
                    exprsNodes,
                    type,
                    clone,
                    roots[0]
                  )
                );
              } else {
                path.replaceWith(
                  t.arrayExpression(
                    roots.map((root) =>
                      transformRootNode(
                        importSymbol,
                        path,
                        exprsNodes,
                        type,
                        clone,
                        root
                      )
                    )
                  )
                );
              }
            } catch (e) {
              if (e instanceof TemplateParserError) {
                const s = path.get("quasi").get("quasis")[e.staticsOffset];
                const c = s.node.value.cooked;
                let offset = 0;
                for (let i = 0; i < e.textOffset; i++) {
                  if (c.charCodeAt(i) === 10) {
                    // "\n"
                    offset = 0;
                  } else {
                    offset++;
                  }
                }
                throw s.buildCodeFrameError(
                  e.message +
                  "\n\n" +
                  s.node.value.cooked +
                  "\n" +
                  "^".padStart(offset) +
                  "\n"
                );
              }
              throw e;
            }
          }
        },
      },
    },
  };
});
export default ivi;

function isProgramScopeIdentifier(path, state) {
  const node = path.node;
  let scope = path.scope;

  while (scope) {
    if (scope.hasOwnBinding(node.name)) {
      if (!scope.path.isProgram()) {
        state.isProgramScope = false;
      }
      return;
    }

    scope = scope.parent;
  }
}

const isProgramScopeVisitor = {
  Identifier: isProgramScopeIdentifier,
};

function tryHoistExpr(expr) {
  const state = { isProgramScope: true };
  if (expr.isReferencedIdentifier()) {
    isProgramScopeIdentifier(expr, state);
  } else {
    expr.traverse(isProgramScopeVisitor, state);
  }
  return state.isProgramScope;
}
