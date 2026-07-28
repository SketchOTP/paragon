// Test fixture: mimics a CLI that prints a login URL, then waits for a
// manually-pasted authorization code on stdin before exiting 0. Models the
// real claude CLI's "Paste code here if prompted >" flow.
process.stdout.write("If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&client_id=x\n");
process.stdout.write("Paste code here if prompted > ");

process.stdin.setEncoding("utf8");
process.stdin.once("data", (chunk) => {
  if (chunk.trim()) {
    process.stdout.write(`received code: ${chunk.trim()}\n`);
    process.exit(0);
  }
  process.exit(1);
});
