import { createEventStore } from "./eventStore.js";
import { generateId } from "./ids.js";
import { newDecision } from "./schemas.js";

export function createDecisionStore(dataDir) {
  const store = createEventStore({ name: "decisions", dataDir });

  /** Persists every evaluated decision (from shadowGovernor.js) with a fresh decisionId + timestamp. */
  async function record({ jobId, sessionId, runId, now = new Date().toISOString() }, decisionInputs) {
    const saved = [];
    for (const input of decisionInputs) {
      const decision = newDecision({
        decisionId: generateId("decision"),
        jobId,
        sessionId,
        runId,
        timestamp: now,
        ...input
      });
      await store.append(decision);
      saved.push(decision);
    }
    return saved;
  }

  function recent(limit = 50) {
    return store
      .all()
      .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))
      .slice(0, limit);
  }

  return { ...store, record, recent };
}
