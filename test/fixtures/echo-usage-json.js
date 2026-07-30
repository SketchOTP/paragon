// Test fixture: a structured-output CLI. Emits a JSONL event stream ending in
// a result envelope that carries real token accounting, in the shape the
// installed `claude --output-format json` actually produces. Used to prove
// that CLI usage is captured when the provider exposes it, and that the
// envelope is unwrapped so the caller receives prose rather than JSON.
import fs from "node:fs";

const logPath = process.env.PARAGON_TEST_INVOCATION_LOG;

process.stdin.setEncoding("utf8");
process.stdin.resume();
process.stdin.on("end", () => {
  if (logPath) {
    fs.appendFileSync(logPath, `${Date.now()}\n`);
  }
  process.stdout.write(`${JSON.stringify({ type: "turn.started" })}\n`);
  process.stdout.write(
    `${JSON.stringify({
      type: "result",
      subtype: "success",
      total_cost_usd: 0.0125,
      result: "structured fixture answer",
      usage: {
        input_tokens: 40,
        cache_creation_input_tokens: 60,
        cache_read_input_tokens: 0,
        output_tokens: 25
      }
    })}\n`
  );
  process.exit(0);
});
