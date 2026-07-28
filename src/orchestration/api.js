import { validatePolicy, mergeOrchestrationConfig } from "./governorPolicy.js";
import { buildUsageSummary } from "./usageLedger.js";
import { detectDuplication } from "./duplication.js";
import { newCheckpoint } from "./schemas.js";
import { generateId } from "./ids.js";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

function paginate(items, req) {
  const limit = Math.min(MAX_LIMIT, Math.max(1, Number(req.query.limit) || DEFAULT_LIMIT));
  const offset = Math.max(0, Number(req.query.offset) || 0);
  return { items: items.slice(offset, offset + limit), total: items.length, limit, offset };
}

function sortedByRecency(items, field) {
  return [...items].sort((a, b) => Date.parse(b[field] ?? 0) - Date.parse(a[field] ?? 0));
}

export function registerOrchestrationRoutes(app, orchestration, getConfig, persistConfig) {
  app.get("/api/orchestration/status", async (_req, res) => {
    const config = await getConfig();
    const jobs = orchestration.jobs.all();
    const sessions = orchestration.sessions.all();
    const runs = orchestration.runs.all();
    const activeSessions = sessions.filter((s) => s.status === "active");
    const openRuns = runs.filter((r) => !r.endTime);
    const longest = activeSessions.reduce(
      (max, s) => Math.max(max, orchestration.sessions.activeDurationMinutes(s)),
      0
    );
    res.json({
      enforcementMode: config.orchestration.mode,
      activeJobs: jobs.filter((j) => j.status === "active").length,
      activeSessions: activeSessions.length,
      activeRuns: openRuns.length,
      maxObservedContextTokens: sessions.reduce((max, s) => Math.max(max, s.maxObservedContextTokens), 0),
      longestActiveSessionMinutes: longest
    });
  });

  app.get("/api/orchestration/jobs", (req, res) => {
    res.json(paginate(sortedByRecency(orchestration.jobs.all(), "createdAt"), req));
  });

  app.get("/api/orchestration/jobs/:id", (req, res) => {
    const job = orchestration.jobs.get(req.params.id);
    if (!job) {
      res.status(404).json({ error: "Unknown job" });
      return;
    }
    res.json(job);
  });

  app.get("/api/orchestration/sessions", (req, res) => {
    res.json(paginate(sortedByRecency(orchestration.sessions.all(), "latestActivityTime"), req));
  });

  app.get("/api/orchestration/sessions/:id", (req, res) => {
    const session = orchestration.sessions.get(req.params.id);
    if (!session) {
      res.status(404).json({ error: "Unknown session" });
      return;
    }
    res.json(session);
  });

  app.get("/api/orchestration/runs", (req, res) => {
    let runs = orchestration.runs.all();
    if (req.query.sessionId) {
      runs = runs.filter((r) => r.sessionId === req.query.sessionId);
    }
    if (req.query.jobId) {
      runs = runs.filter((r) => r.jobId === req.query.jobId);
    }
    res.json(paginate(sortedByRecency(runs, "startTime"), req));
  });

  app.get("/api/orchestration/runs/:id", (req, res) => {
    const run = orchestration.runs.get(req.params.id);
    if (!run) {
      res.status(404).json({ error: "Unknown run" });
      return;
    }
    res.json(run);
  });

  app.get("/api/orchestration/usage", (_req, res) => {
    const summary = buildUsageSummary({ runs: orchestration.runs.all(), sessions: orchestration.sessions.all() });
    res.json(summary);
  });

  app.get("/api/orchestration/decisions", (req, res) => {
    res.json(paginate(orchestration.decisions.recent(MAX_LIMIT), req));
  });

  app.get("/api/orchestration/duplication", (_req, res) => {
    res.json({ signals: detectDuplication(orchestration.runs.all()) });
  });

  app.get("/api/orchestration/policy", async (_req, res) => {
    const config = await getConfig();
    res.json(config.orchestration);
  });

  app.put("/api/orchestration/policy", async (req, res) => {
    const config = await getConfig();
    const candidate = mergeOrchestrationConfig(config.orchestration, req.body);
    const { ok, errors } = validatePolicy(candidate);
    if (!ok) {
      res.status(400).json({ error: { message: "Invalid orchestration policy", details: errors } });
      return;
    }
    const nextConfig = await persistConfig({ ...config, orchestration: candidate });
    res.json(nextConfig.orchestration);
  });

  app.post("/api/orchestration/checkpoints", async (req, res) => {
    const body = req.body ?? {};
    if (!body.jobId || !body.sessionId) {
      res.status(400).json({ error: "jobId and sessionId are required" });
      return;
    }
    const checkpoint = await orchestration.checkpoints.create({
      checkpointId: generateId("checkpoint"),
      jobId: body.jobId,
      sessionId: body.sessionId,
      runId: body.runId ?? null,
      timestamp: new Date().toISOString(),
      activeObjective: body.activeObjective ?? null,
      completedWorkSummary: body.completedWorkSummary ?? null,
      remainingWorkSummary: body.remainingWorkSummary ?? null,
      repository: body.repository ?? null,
      validationState: body.validationState ?? null,
      unresolvedFailures: body.unresolvedFailures ?? [],
      relevantFiles: body.relevantFiles ?? [],
      source: "manual"
    });
    res.status(201).json(checkpoint);
  });
}

// Re-exported for schema reuse in tests without importing internals directly.
export { newCheckpoint };
