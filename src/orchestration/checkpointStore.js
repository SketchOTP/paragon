import { createEventStore } from "./eventStore.js";
import { newCheckpoint } from "./schemas.js";

export function createCheckpointStore(dataDir) {
  const store = createEventStore({ name: "checkpoints", dataDir });

  async function create(params) {
    const checkpoint = newCheckpoint(params);
    await store.append(checkpoint);
    return checkpoint;
  }

  function bySession(sessionId) {
    return store.all().filter((c) => c.sessionId === sessionId);
  }

  return { ...store, create, bySession };
}
