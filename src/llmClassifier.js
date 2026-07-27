import { runProvider } from "./cli.js";

const CLASSIFICATION_PROMPT = `
Classify the following user task into one of the following categories:
- ask: Questions, explanations, learning, read-only Q&A.
- agent: Implementation, edits, refactors, applying changes.
- multitask: Parallel work, batch tasks, multiple concurrent goals.
- debug: Bugs, errors, fixing code, stack traces, exceptions, diagnosis.
- review: Code reviews, diffs, pull requests, security risks.
- docs: Documentation, READMEs, changelogs.
- plan: Architecture, design, roadmaps, strategic approaches.
- explain: Explanations, how-tos, summaries, teaching.
- code: Implementation, building, refactoring, new features.
- quick: Simple, one-line, short requests.

Respond with ONLY the category name.

Task:
"{{prompt}}"
`;

export async function llmClassifyTask(prompt, config) {
  const routing = config?.routing ?? {};
  const provider = routing.defaultProvider ?? "codex";
  const providerConfig = config?.providers?.[provider];

  if (!providerConfig || !providerConfig.enabled) {
    return null; // Fallback to regex if LLM is unavailable
  }

  const finalPrompt = CLASSIFICATION_PROMPT.replace("{{prompt}}", prompt);

  try {
    const result = await runProvider(provider, providerConfig, finalPrompt);
    return result.stdout.trim().toLowerCase();
  } catch (error) {
    console.error("LLM classification failed, falling back to regex:", error);
    return null; // Fallback to regex
  }
}
