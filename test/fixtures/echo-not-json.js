// Test fixture: reads the piped prompt, replies with plain (non-JSON) text.
// Used to prove validation-driven escalation triggers when a caller asked
// for JSON output and got something else back.
process.stdin.setEncoding("utf8");
let input = "";
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  process.stdout.write("this is definitely not json\n");
  process.exit(0);
});
