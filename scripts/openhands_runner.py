#!/usr/bin/env python3
"""Run one OpenHands SDK coding-agent turn for PARAGON.

The Node gateway owns routing, authentication, timeouts, and telemetry. This
small process owns only the OpenHands agent lifecycle so the Python SDK cannot
take down the gateway if it fails to import or execute.

Input: one JSON object on stdin with prompt, workspace, and optional PARAGON
endpoint settings. The model is intentionally fixed to PARAGON's logical model.
Output: one JSON object on stdout with the final agent response and optional
cost evidence. Diagnostics/logging belongs on stderr so stdout stays a stable
machine-readable provider contract.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path


def emit(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def final_agent_text(conversation) -> str:
    """Return the last visible agent message without making another LLM call."""
    for event in reversed(conversation.state.events):
        if getattr(event, "source", None) != "agent":
            continue
        to_llm_message = getattr(event, "to_llm_message", None)
        if not callable(to_llm_message):
            continue
        message = to_llm_message()
        parts = []
        for content in getattr(message, "content", []) or []:
            text = getattr(content, "text", None)
            if text:
                parts.append(str(text))
        if parts:
            return "\n".join(parts).strip()
    return "OpenHands completed the task without a final text response."


def main() -> int:
    try:
        request = json.load(sys.stdin)
        workspace = Path(str(request.get("workspace", ""))).expanduser().resolve()
        if not workspace.is_absolute() or not workspace.is_dir():
            raise ValueError(f"workspace is not an existing directory: {workspace}")

        # Imports are deliberately inside main: a missing SDK becomes a normal
        # provider failure rather than preventing PARAGON from starting.
        from pydantic import SecretStr
        from openhands.sdk import Agent, Conversation, LLM, Tool
        from openhands.tools.file_editor import FileEditorTool
        from openhands.tools.task_tracker import TaskTrackerTool
        from openhands.tools.terminal import TerminalTool

        requested_model = str(request.get("model") or "").strip()
        if requested_model and requested_model != "openai/paragon":
            raise ValueError("OpenHands must use the logical PARAGON model: openai/paragon")
        model = "openai/paragon"
        api_key = str(request.get("apiKey") or os.environ.get("PARAGON_API_KEY") or "")
        base_url = str(request.get("baseUrl") or os.environ.get("PARAGON_BASE_URL") or "http://127.0.0.1:4117/v1")
        if not api_key:
            raise ValueError("PARAGON_API_KEY is required")
        llm = LLM(
            usage_id="paragon-openhands",
            model=model,
            base_url=base_url,
            api_key=SecretStr(api_key),
        )
        agent = Agent(
            llm=llm,
            tools=[
                Tool(name=TerminalTool.name),
                Tool(name=FileEditorTool.name),
                Tool(name=TaskTrackerTool.name),
            ],
        )
        conversation = Conversation(
            agent=agent,
            workspace=str(workspace),
            max_iteration_per_run=int(request.get("maxIterations") or os.environ.get("OPENHANDS_MAX_ITERATIONS", "50")),
        )
        prompt = str(request.get("prompt") or "").strip()
        if not prompt:
            raise ValueError("OpenHands received an empty prompt")
        conversation.send_message(prompt)
        conversation.run()

        payload = {
            "result": final_agent_text(conversation),
            "agent": "openhands",
        }
        cost = getattr(getattr(llm, "metrics", None), "accumulated_cost", None)
        if cost is not None:
            payload["usage"] = {"cost_usd": float(cost)}
        emit(payload)
        return 0
    except Exception as error:  # noqa: BLE001 - boundary must report cleanly to Node
        print(f"OpenHands runner: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
