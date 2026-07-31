# PARAGON Expert-Tuple Routing Qualification

Status: `PARAGON_EXPERT_TUPLE_ROUTING_QUALIFIED`

This is a qualification record for the implementation on the authoritative
`origin/main` base. It does not authorize merge, deployment, or a production
restart. Qualification and deployment remain separate stages.

## Scope and isolation

- Qualification root: `/tmp/paragon-expert-qualification`
- PARAGON was run from the clean qualification checkout on port `4999`.
- Production was not modified or restarted.
- OpenHands used the repository-owned `scripts/openhands_runner.py` with the
  repository-local `.openhands-venv`.
- OpenHands SDK/tool packages were installed at version `1.39.1`.
- The runner used bubblewrap and bound only the selected qualification
  workspace writable.
- No credential value is stored in this report or the evidence files.

## Real provider evidence

| Provider | Exact tuple exercised | Result | Evidence |
|---|---|---|---|
| Claude | `claude / claude-sonnet-4-6 / high / native_agent_cli` | Qualified: exact model/profile reached the CLI and the workspace artifact was verified | `64b5de05-d927-42ff-96e7-16110c7f7c59` |
| Antigravity | `antigravity / gemini-3.6-flash-high / high / native_agent_cli` | Qualified after adding the explicit workspace directory; artifact verified | `adc95e84-c93b-48a1-9ba6-7de9da8efc02` |
| Codex | `codex / gpt-5.4 / medium / native_agent_cli` | Qualified after the targeted launch-path correction; exact workspace artifact and JSONL tool events verified | `9a1ae427-5530-4375-96e0-39d6d6aa0123` |
| Cursor | `cursor / composer-2.5 / unknown / native_agent_cli` | `operational_status: unavailable`; real provider quota exhaustion was correctly classified as `QUOTA_EXHAUSTED` and treated provider-wide | `cursor-to-http-final/cursor-http-fallback-proof.txt` |
| LM Studio | `lmstudio / google/gemma-4-e2b / medium / openai_compatible_http` | Qualified full outer loop after absolute-path and byte-exact prompt correction; tool call, continuation, final response, and artifact verified | `lmstudio-full-loop-byteexact` |
| OpenRouter | `openrouter / qwen/qwen3-coder / medium / openai_compatible_http` | Qualified for the required outer loop: OpenHands selected workspace tools, PARAGON selected the OpenRouter tuple, and the artifact was verified | `openhands-openrouter-final-2/openrouter-expert-proof.txt` |

The OpenRouter proof used an isolated catalog/config containing only the
verified qualification tuple. The final PARAGON routing plan recorded:

`openrouter / qwen/qwen3-coder / medium / openai_compatible_http`

with expert id `openrouter|qwen/qwen3-coder`. The workspace contained exactly
`OPENROUTER_OPENHANDS_PROOF` after the OpenHands turn.

## Required routing proofs

Passed implementation-level evidence:

- complete tuple identity includes provider, exact model, reasoning profile,
  execution path, and stable expert id;
- native CLI and HTTP execution methods are distinct;
- native CLI tool execution satisfies the general `toolExecution` gate without
  pretending to be OpenAI wire-level `toolCalls`;
- the selected tuple is copied into the attempt plan and provider config;
- exact native CLI model and reasoning profile are preserved through dispatch;
- one automatic route computation is used by the request path;
- one provider executor is created per attempt;
- the OpenHands runner does not invoke PARAGON recursively.

All four required end-to-end routing proofs passed:

1. **Native CLI → OpenHands HTTP.** The unforced ordered plan was:

   ```text
   1. cursor / composer-2.5 / unknown / native_agent_cli
   2. openrouter / qwen/qwen3-coder / medium / openai_compatible_http
   ```

   Cursor was dispatched once and returned its genuine usage-limit error.
   PARAGON classified it as `QUOTA_EXHAUSTED`, skipped all remaining Cursor
   tuples, and continued to the original OpenRouter tuple. OpenHands made one
   outer execution, OpenRouter created
   `cursor-http-fallback-proof.txt`, and the parent verified the exact bytes
   `PARAGON_CURSOR_TO_HTTP_FALLBACK_OK` plus `0a`. Cursor created no artifact.

2. **OpenHands HTTP → native CLI.** The original plan was:

   ```text
   1. openrouter / qwen/a-model-that-does-not-exist / medium / openai_compatible_http
   2. claude / claude-sonnet-4-6 / high / native_agent_cli
   ```

   OpenRouter was actually dispatched and returned the genuine model-specific
   error `not a valid model ID`. PARAGON classified it as `MODEL_NOT_FOUND`,
   removed only that exact tuple, and dispatched Claude. Claude received the
   registered workspace and exact `claude-sonnet-4-6 / high` tuple and created
   `http-native-fallback-proof.txt`; the exact bytes ended in `0a`. The
   OpenHands runner remained the sole outer executor and no nested OpenHands
   process was launched.

3. **Same-provider model fallback.** The clean post-fix plan was:

   ```text
   1. openrouter / qwen/a-model-that-does-not-exist / medium / openai_compatible_http
      expert_id: openrouter|qwen/a-model-that-does-not-exist|medium|openai_compatible_http
   2. openrouter / qwen/qwen3-coder / medium / openai_compatible_http
      expert_id: openrouter|qwen/qwen3-coder|medium|openai_compatible_http
   ```

   Model A failed with `MODEL_NOT_FOUND`; model B succeeded without provider
   default substitution. Diagnostics recorded one model-specific failed
   sample and one successful sample under the distinct tuple identities.

4. **Ordinary unforced native selection.** With the full six-provider pool
   present—Claude, Codex, Cursor, Antigravity, OpenRouter, and LM Studio—and
   no provider/model forcing, the quality-priority expected-utility router
   selected:

   ```text
   codex / gpt-5.4 / medium / native_agent_cli
   expert_id: codex|gpt-5.4|medium|native_agent_cli
   ```

   The dispatched Codex process used the registered workspace, exact model,
   medium reasoning profile, and native CLI path. OpenHands observed the
   resulting native-agent events. The first Codex attempt exposed a failed
   tool event and was bounded-retried as the same exact tuple; each attempt
   had one native executor. The successful attempt created the artifact, and
   the parent verified `ordinary-native-proof.txt` ended in `0a`.

Cursor remains operationally unavailable, not unqualified:

```text
operational_status: unavailable
reason: QUOTA_EXHAUSTED
qualification_behavior: correctly classified
```

## LM Studio full-loop diagnosis

`google/gemma-4-e2b` first produced a valid OpenAI tool call. The initial
OpenHands continuation failed because the model supplied a relative path to a
FileEditor tool that requires an absolute path, then repeated that invalid
call. A bounded rerun with the registered absolute workspace path completed,
but wrote literal `\\n` bytes instead of a newline. The final bounded rerun
used an explicit absolute path and `printf`; OpenHands executed the tool,
returned the tool result through PARAGON, received a final completion, and
the parent verified the artifact bytes ended in `0a`.

The successful workspace was:

`/tmp/paragon-expert-qualification/workspaces/lmstudio-full-loop-qualified`

It contained only `lmstudio-expert-proof.txt`, with exact content
`PARAGON_LMSTUDIO_EXPERT_OK` plus one newline byte. The runner used exactly
one OpenHands executor and did not launch PARAGON recursively. The isolated
automatic plan recorded expert id
`lmstudio|google/gemma-4-e2b|medium|openai_compatible_http`.

The retained `google/gemma-4-26b-a4b-qat` result remains
`qualification=FAILED_NO_TOOL_CALL`; it was not repeatedly probed.

## Fallback-path corrections and evidence boundary

The first fallback preview found that `rankCandidates()` dropped
`isHttpProvider`, `executionMethod`, `executionPath`, and `expertId`. This
caused an HTTP tuple to reach the attempt plan labeled as native CLI. The
ranking result now preserves those fields, and a regression test covers the
HTTP identity through ranking and planning.

The live preview then exposed a second propagation defect: ranked results
carried `reasoningEffort`, while the attempt-plan builder only read the richer
pre-ranking execution-profile object. HTTP tuples could therefore dispatch
with `reasoningProfile: unknown`. The attempt-plan builder now preserves
`reasoningEffort` as the exact reasoning profile, with regression coverage.

A same-provider OpenRouter probe then received the genuine model-specific
error `qwen/a-model-that-does-not-exist is not a valid model ID`. PARAGON had
classified that response as `TRANSIENT_FAILURE`; the classifier now recognizes
`not a valid model` as `MODEL_NOT_FOUND`, and a regression test covers it. The
clean post-fix fallback evidence is recorded above.

The failed LM Studio continuation probe remains a diagnosis artifact only; the
independent OpenRouter HTTP path was used for the passing native-to-HTTP proof.

## Codex native-agent root-cause diagnosis

Primary classification: `CODEX_NATIVE_AGENT_QUALIFIED` after correction.

The pre-change direct control using the configured `codex` command resolved to
`/snap/bin/codex` (realpath `/usr/bin/snap`). It exited with
`Error: No such file or directory`, emitted zero JSONL events, and created no
artifact. This was a Codex snap-launcher/sandbox-helper failure, not a model
or workspace forwarding failure. The installed native ELF at
`/snap/codex/34/bin/codex` succeeded with the same exact model, reasoning
profile, process cwd, `--cd`, and `workspace-write` sandbox.

The targeted correction was limited to Codex execution: PARAGON resolves the
installed `/snap/codex/current/bin/codex` ELF when the configured command is
`codex` or `/snap/bin/codex`; Codex native runs now use the supported
`exec --json --ephemeral --skip-git-repo-check --sandbox ...` contract; and
zero-exit Codex JSONL containing failed tool events is rejected rather than
classified as success. No danger-full-access mode or broader workspace bind
was used.

The direct control with the real ELF produced a real command event, persisted
`codex-expert-proof.txt` under the registered workspace, and matched the
required bytes (`PARAGON_CODEX_EXPERT_OK` plus the file's normal final
newline). The PARAGON dispatch proof used the same exact tuple and recorded
expert id `codex|gpt-5.4|medium|native_agent_cli`; its process cwd and Codex
`--cd` both resolved to `/tmp/paragon-expert-qualification/workspaces/codex-diagnosis-paragon`.
Parent-side verification found only the registration marker and the required
artifact; no artifact was written outside the workspace.

The earlier evidence id `c5064a4a-e34e-45e1-9d4f-0ceb93db74a7` remains a valid
pre-correction failure record and is superseded for Codex qualification by
`9a1ae427-5530-4375-96e0-39d6d6aa0123`.

The OpenRouter outer-loop proof initially exposed an isolated catalog-refresh
problem; the server was restarted only in the qualification checkout with
refresh disabled, then rerun using a restricted isolated catalog. This is
qualification evidence, not production activation evidence.

## Test baseline and final checks

- Authoritative clean baseline: `npm test` — **370 passed, 0 failed, 0 skipped**.
- Current implementation suite: **378 passed, 0 failed, 0 skipped**.
- The increase is eight added tuple/capability/Codex-diagnosis tests; no
  baseline tests were intentionally deleted or skipped.
- `npm run check` — passed.
- `git diff --check` — passed.

## Verdict

The tuple representation, native/HTTP dispatch split, bidirectional fallback,
same-provider fallback, and ordinary unforced native selection are proven in
isolated workspaces. Therefore the qualification verdict is:

`PARAGON_EXPERT_TUPLE_ROUTING_QUALIFIED`

Do not merge, deploy, or restart production on this evidence.
