// Test fixture: reads the piped prompt, then exits non-zero with a
// realistic "invalid model" message on stdout (matching the real claude
// CLI's actual invalid-model phrasing — see modelCatalog.test.js). Used to
// exercise the model-catalog validation-failure path without depending on
// a real installed CLI.
process.stdin.setEncoding("utf8");
let input = "";
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  process.stdout.write("There's an issue with the selected model. It may not exist or you may not have access to it.\n");
  process.exit(1);
});
