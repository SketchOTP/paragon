// Test fixture: reads the piped prompt, then exits non-zero with the *real*
// cursor-agent monthly-allowance message. Used to exercise provider-wide quota
// handling — classification, reset parsing, and skipping every remaining
// attempt for that provider — without depending on an actually exhausted
// subscription.
//
// The reset date is deliberately far in the future so the exclusion is stable
// for the duration of a test run.
process.stdin.setEncoding("utf8");
let input = "";
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  process.stdout.write(
    "ActionRequiredError: You've hit your usage limit You've saved $2504 on API model usage this month with Ultra. " +
      "Switch to a different model or set a Spend Limit to continue with this model. " +
      "Your usage limits will reset when your monthly cycle ends on 8/12/2099.\n"
  );
  process.exit(1);
});
