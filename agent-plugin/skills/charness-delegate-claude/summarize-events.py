#!/usr/bin/env python3
"""Summarize a detached `claude -p --output-format stream-json` worker log.

Usage: summarize-events.py <events.jsonl> [<tool calls to show>]

Prints the model, the last tool calls, the last text, the final result and the account's usage windows,
so a manager can judge a worker's progress without reading the raw stream.
"""

import json
import sys

defaultToolCallCount = 8
textPreviewLength = 300
inputPreviewLength = 120


def readEvents(path):
    events = []
    with open(path, encoding="utf-8", errors="replace") as file:
        for line in file:
            line = line.strip()
            if not line:
                continue
            try:
                events.append(json.loads(line))
            except json.JSONDecodeError:
                continue  # a line still being written
    return events


def describeToolInput(toolInput):
    if not isinstance(toolInput, dict):
        return ""
    for key in ("command", "file_path", "pattern", "description", "prompt"):
        value = toolInput.get(key)
        if isinstance(value, str) and value:
            return " ".join(value.split())[:inputPreviewLength]
    return ""


def main():
    if len(sys.argv) < 2:
        print(__doc__.strip())
        return 2
    toolCallCount = int(sys.argv[2]) if len(sys.argv) > 2 else defaultToolCallCount
    events = readEvents(sys.argv[1])

    model = None
    toolCalls = []
    lastText = ""
    result = None
    usageWindows = {}
    for event in events:
        eventType = event.get("type")
        if eventType == "system" and event.get("subtype") == "init":
            model = event.get("model")
        elif eventType == "assistant":
            for block in (event.get("message") or {}).get("content") or []:
                if block.get("type") == "tool_use":
                    toolCalls.append(f"{block.get('name')}: {describeToolInput(block.get('input'))}")
                elif block.get("type") == "text" and block.get("text", "").strip():
                    lastText = block["text"]
        elif eventType == "result":
            result = event
        elif eventType == "rate_limit_event":
            windows = (event.get("rate_limit_info") or {}).get("unifiedWindows") or {}
            for name, window in windows.items():
                usageWindows[name] = window

    print(f"events: {len(events)}  model: {model}  tool calls: {len(toolCalls)}")
    if toolCalls:
        print("last tool calls:")
        for call in toolCalls[-toolCallCount:]:
            print(f"  - {call}")
    if lastText:
        print("last text: " + " ".join(lastText.split())[:textPreviewLength])
    if result is None:
        print("result: none yet (still running, or it died before finishing)")
    else:
        summary = {key: result.get(key) for key in ("subtype", "is_error", "num_turns", "total_cost_usd")}
        print(f"result: {json.dumps(summary)}")
        print("result text: " + " ".join(str(result.get("result", "")).split())[:textPreviewLength])
    for name, window in sorted(usageWindows.items()):
        print(f"usage {name}: {window.get('utilization')} (resets at {window.get('resetsAt')}, {window.get('status')})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
