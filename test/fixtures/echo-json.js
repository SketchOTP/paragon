// Test fixture: reads the piped prompt, replies with valid JSON. Used as
// the escalation target in validation-driven-escalation tests.
process.stdin.setEncoding("utf8");
let input = "";
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  process.stdout.write(JSON.stringify({ ok: true, receivedChars: input.length }) + "\n");
  process.exit(0);
});
