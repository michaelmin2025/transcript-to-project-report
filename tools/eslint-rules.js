function definesFunction(node) {
  const declaration = node.declaration || node;

  return declaration.type === "FunctionDeclaration"
    || (declaration.type === "VariableDeclaration"
      && declaration.declarations.some(({ init }) =>
        init?.type === "ArrowFunctionExpression" || init?.type === "FunctionExpression"));
}

export default {
  rules: {
    "function-spacing": {
      meta: {
        type: "layout",
        fixable: "whitespace",
        schema: [],
        messages: { missing: "Add a blank line before and after function definitions." },
      },
      create(context) {
        const source = context.sourceCode;

        function checkStatements(statements) {
          for (let index = 1; index < statements.length; index += 1) {
            const previous = statements[index - 1];
            const current = statements[index];

            if (!definesFunction(previous) && !definesFunction(current)) {
              continue;
            }

            const gap = source.text.slice(previous.range[1], current.range[0]);

            if (/\n[ \t]*\r?\n/.test(gap)) {
              continue;
            }

            context.report({
              node: current,
              messageId: "missing",
              fix: fixer => fixer.insertTextAfter(previous, gap.includes("\n") ? "\n" : "\n\n"),
            });
          }
        }

        return {
          Program: node => checkStatements(node.body),
          BlockStatement: node => checkStatements(node.body),
          SwitchCase: node => checkStatements(node.consequent),
        };
      },
    },
  },
};
