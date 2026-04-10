---
name: capy
description: Orchestrate Capy.ai coding agents with quality gates. Delegate coding work, wait for completion, review quality, approve or retry.
metadata:
  author: yazcaleb
  version: "0.3.6"
---

# capy

Orchestrate Capy.ai coding agents. Start tasks, wait for them, enforce quality gates, approve or retry. Works with any AI agent (Claude Code, Codex, OpenClaw, Poke).

## Install

```bash
npm i -g capyai
capy init
```

Or set env vars directly:
```bash
export CAPY_API_KEY=capy_...
export CAPY_PROJECT_ID=...
```

## Agent workflow

The core loop for any agent:

```bash
# 1. Start work
capy captain "Implement feature X. Files: src/foo.ts. Tests required." --json

# 2. Wait for completion (blocks until done)
capy wait <thread-id> --timeout=600 --json

# 3. Check quality gates
capy review <task-id> --json
# Parse quality.pass boolean

# 4a. If pass: approve
capy approve <task-id> --json

# 4b. If fail: retry with context
capy retry <task-id> --fix="fix the failing CI check" --json
# Go back to step 2
```

## Commands

| Command | What it does |
|---------|-------------|
| `capy captain "<prompt>"` | Start Captain thread (primary agent) |
| `capy build "<prompt>"` | Start Build agent (isolated, small tasks) |
| `capy wait <id>` | Block until task/thread reaches terminal state |
| `capy review <id>` | Run quality gates (pr_exists, ci, greptile, threads, tests) |
| `capy approve <id>` | Approve if all gates pass |
| `capy retry <id> --fix="..."` | Retry with failure context from previous attempt |
| `capy status` | Dashboard of all threads and tasks |
| `capy list [status]` | List tasks, optionally filtered |
| `capy get <id>` | Task or thread details |
| `capy diff <id>` | View diff from task |
| `capy pr <id>` | Create PR for task |
| `capy threads list` | List Captain threads |
| `capy threads get <id>` | Thread details |
| `capy threads msg <id> <text>` | Message a thread |
| `capy threads stop <id>` | Stop a thread |
| `capy threads messages <id>` | View thread messages |

All commands support `--json` for machine-readable output.

## Quality gates

`capy review` checks pass/fail gates:

- **pr_exists** — PR was created
- **pr_open** — PR is OPEN or MERGED
- **ci** — CI checks passing
- **greptile** — No unaddressed Greptile issues
- **threads** — No unresolved GitHub review threads
- **tests** — Diff includes test files

Configure which run via `capy config quality.reviewProvider greptile|capy|both|none`.

## JSON output

Every command returns structured JSON with `--json`. Errors return `{ "error": { "code": "...", "message": "..." } }`.

Key fields for agents:
- `capy review --json` → `quality.pass` (boolean), `quality.gates` (array)
- `capy wait --json` → full task/thread object on completion, `error.code: "timeout"` on timeout
- `capy retry --json` → `newThread` (thread ID to wait on)

## Prompting tips

Bad: "Fix the CI issue"
Good: "Fix CI for crypto-trading pack. The changeset file is missing. Add a changeset entry for @veto/crypto-trading. Run changeset validation. Reference: PLW-201."

Specific files, specific functions, specific acceptance criteria.

## Triggers

Keywords: capy, captain, build agent, quality gates, delegate coding, orchestrate agents, send to capy, approve task, retry task
