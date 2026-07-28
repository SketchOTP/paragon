/**
 * Pure policy evaluation. Never mutates execution — callers only ever log
 * the returned decisions (headers, activity log, dashboard, decisions.jsonl).
 * D-002 forbids enforcement outright: nothing here can reject a request,
 * truncate context, or affect provider selection.
 */

function decision(rule, observedValue, threshold, proposedAction, explanation, confidence = "medium") {
  return { policyRule: rule, observedValue, threshold, proposedAction, explanation, confidence, missingEvidence: [] };
}

export function evaluateContext(policy, estimatedInputTokens) {
  const decisions = [];
  const c = policy.context;
  if (estimatedInputTokens >= c.absoluteCeilingTokens) {
    decisions.push(
      decision(
        "context.absoluteCeiling",
        estimatedInputTokens,
        c.absoluteCeilingTokens,
        "would_block_request",
        `Estimated ${estimatedInputTokens} tokens exceeds the proposed absolute ceiling of ${c.absoluteCeilingTokens}. Shadow mode: no request was blocked.`
      )
    );
  } else if (estimatedInputTokens >= c.rolloverTokens) {
    decisions.push(
      decision(
        "context.rollover",
        estimatedInputTokens,
        c.rolloverTokens,
        "propose_session_rollover",
        `Estimated ${estimatedInputTokens} tokens exceeds the proposed rollover threshold of ${c.rolloverTokens}.`
      )
    );
  } else if (estimatedInputTokens >= c.checkpointTokens) {
    decisions.push(
      decision(
        "context.checkpoint",
        estimatedInputTokens,
        c.checkpointTokens,
        "propose_checkpoint",
        `Estimated ${estimatedInputTokens} tokens exceeds the proposed checkpoint threshold of ${c.checkpointTokens}.`
      )
    );
  } else if (estimatedInputTokens >= c.warningTokens) {
    decisions.push(
      decision(
        "context.warning",
        estimatedInputTokens,
        c.warningTokens,
        "warn",
        `Estimated ${estimatedInputTokens} tokens exceeds the warning threshold of ${c.warningTokens}.`,
        "low"
      )
    );
  }
  return decisions;
}

export function evaluateSessionDuration(policy, activeDurationMinutes) {
  const decisions = [];
  const s = policy.session;
  if (activeDurationMinutes >= s.longSessionMinutes) {
    decisions.push(
      decision(
        "session.longRunning",
        activeDurationMinutes,
        s.longSessionMinutes,
        "warn",
        `Session has been active for ${activeDurationMinutes} minutes, past the ${s.longSessionMinutes}-minute long-session warning.`
      )
    );
  } else if (activeDurationMinutes >= s.rolloverMinutes) {
    decisions.push(
      decision(
        "session.rollover",
        activeDurationMinutes,
        s.rolloverMinutes,
        "propose_session_rollover",
        `Session active duration ${activeDurationMinutes}m exceeds the proposed rollover threshold of ${s.rolloverMinutes}m.`
      )
    );
  } else if (activeDurationMinutes >= s.checkpointMinutes) {
    decisions.push(
      decision(
        "session.checkpoint",
        activeDurationMinutes,
        s.checkpointMinutes,
        "propose_checkpoint",
        `Session active duration ${activeDurationMinutes}m exceeds the proposed checkpoint threshold of ${s.checkpointMinutes}m.`
      )
    );
  }
  return decisions;
}

export function evaluateSubagents(policy, { parallelChildRuns = 0, totalChildRunsInJob = 0, hasRecursiveChild = false } = {}) {
  const decisions = [];
  const sub = policy.subagents;

  if (parallelChildRuns > sub.parallelLimit) {
    decisions.push(
      decision(
        "subagents.parallelLimit",
        parallelChildRuns,
        sub.parallelLimit,
        "would_prevent_spawn",
        `${parallelChildRuns} overlapping child runs exceed the proposed parallel limit of ${sub.parallelLimit}. Shadow mode: no spawn was prevented.`
      )
    );
  }
  if (totalChildRunsInJob > sub.totalPerJobLimit) {
    decisions.push(
      decision(
        "subagents.totalPerJobLimit",
        totalChildRunsInJob,
        sub.totalPerJobLimit,
        "would_prevent_spawn",
        `${totalChildRunsInJob} total child runs exceed the proposed per-job limit of ${sub.totalPerJobLimit}. Shadow mode: no spawn was prevented.`
      )
    );
  }
  if (hasRecursiveChild && !sub.recursiveChildrenAllowed) {
    decisions.push(
      decision(
        "subagents.recursiveChildrenProhibited",
        true,
        false,
        "would_prevent_spawn",
        "A child run spawned its own child run, which the proposed policy prohibits. Shadow mode: no spawn was prevented."
      )
    );
  }
  return decisions;
}

/** Runs every configured policy family and returns a flat list of decision inputs (unpersisted). */
export function evaluateShadowGovernor(policy, { estimatedInputTokens, activeDurationMinutes, subagentCounts }) {
  if (policy.mode === "off") {
    return [];
  }
  return [
    ...(estimatedInputTokens != null ? evaluateContext(policy, estimatedInputTokens) : []),
    ...(activeDurationMinutes != null ? evaluateSessionDuration(policy, activeDurationMinutes) : []),
    ...(subagentCounts ? evaluateSubagents(policy, subagentCounts) : [])
  ];
}
