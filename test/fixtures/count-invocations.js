// Test fixture: appends one line per invocation to PARAGON_TEST_INVOCATION_LOG,
// then replies with valid JSON. Used to prove that PARAGON-D-004D shadow
// analysis adds no provider calls — the count must rise by exactly one per
// real request regardless of how many candidates the shadow engine ranks.
import fs from "node:fs";

const logPath = process.env.PARAGON_TEST_INVOCATION_LOG;

process.stdin.setEncoding("utf8");
process.stdin.resume();
process.stdin.on("end", () => {
  if (logPath) {
    fs.appendFileSync(logPath, `${Date.now()}\n`);
  }
  process.stdout.write(JSON.stringify({ ok: true }) + "\n");
  process.exit(0);
});
