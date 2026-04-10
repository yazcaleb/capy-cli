# capy

Agent orchestrator with quality gates. Zero dependencies.

## Install

```bash
npm i -g capyai    # or: bun i -g capyai
capy init                     # interactive setup
```

Or env vars:
```bash
export CAPY_API_KEY=capy_...
export CAPY_PROJECT_ID=...
```

## Setup

Config lives at `~/.capy/config.json`. Set it via `capy config` or edit directly.

```bash
capy config defaultModel gpt-5.4
capy config quality.reviewProvider greptile   # greptile | capy | both | none
capy config quality.requireTests true
capy config notifyCommand "your-notify-cmd --text {text}"
capy config approveCommand "your-post-approve-hook {task} {pr}"
```

Env vars override config: `CAPY_API_KEY`, `CAPY_PROJECT_ID`, `CAPY_SERVER`, `CAPY_ENV_FILE`, `GREPTILE_API_KEY`.

## Commands

### Start work

```bash
capy captain "Implement feature X. Files: src/foo.ts, src/bar.ts. Tests required. Ref: PROJ-123"
capy build "Fix typo in README"       # small isolated tasks
```

Captain is the primary agent. It reads code, plans, edits, commits, creates PRs, delegates sub-agents. Use it for everything except tiny tasks.

### Monitor

```bash
capy status                           # full dashboard
capy list [in_progress|needs_review|backlog]
capy get <id>                         # task details
capy wait <id> --timeout=300          # block until done (for agents)
capy watch <id>                       # cron poll, notify on completion
capy threads list                     # captain threads
```

### Review + approve

```bash
capy review <id>                      # quality gate check
capy approve <id>                     # approve if all gates pass
capy approve <id> --force             # override failing gates
capy retry <id> --fix="fix the X"     # retry with context
```

### Quality gates

`capy review` checks these gates (all pass/fail):

| Gate | What it checks |
|------|---------------|
| `pr_exists` | PR was created |
| `pr_open` | PR is OPEN or MERGED |
| `ci` | CI checks passing (Greptile's own check excluded) |
| `greptile` | No unaddressed Greptile issues (live API) |
| `greptile_check` | Greptile's GitHub status check |
| `threads` | No unresolved GitHub review threads |
| `tests` | Diff includes test files |

Which gates run depends on `quality.reviewProvider`:
- `greptile`: greptile + greptile_check gates
- `capy`: threads gate
- `both`: all of the above
- `none`: skip review gates

### Review providers

**Greptile** (default): Uses the Greptile MCP API to check unaddressed issues. Greptile auto-reviews on every push if `triggerOnUpdates` is enabled in your repo's greptile.json. The confidence score in PR comments is ONE-TIME and never updates. Ignore it. Unaddressed issues from the API is the real signal.

**Capy**: Uses GitHub's unresolved review threads. When Capy's review agent posts comments, those threads must be resolved before approval.

**Both**: Runs both. Strictest mode.

### The review loop

```
capy review <id>           # see what's failing
capy retry <id> --fix="X"  # fix it
capy watch <thread-id>     # wait for agent
# agent pushes -> Greptile auto-reviews -> wait ~60s
capy review <id>           # check again
capy approve <id>          # all gates pass? approve
```

## For agents (Claude Code, Codex, OpenClaw)

Every command supports `--json` for machine-readable output:

```bash
capy review SCO-1 --json   # structured gate results
capy status --json          # full state dump
capy list --json            # task array
```

Parse the `quality.pass` boolean from `capy review --json` to decide next action.

When orchestrating:
1. `capy captain "<precise prompt>" --json` to start work
2. `capy wait <thread-id> --timeout=600 --json` to block until done
3. `capy review <task-id> --json` to check gates
4. If `pass: false`, read `gates` array for what's failing
5. `capy retry <task-id> --fix="<specific fix>" --json` returns `newThread` ID
6. `capy wait <new-thread-id> --json` to block on retry
7. If `pass: true`, `capy approve <task-id> --json`

### MCP server

For agents that prefer MCP (Cursor, some Codex configs):

```json
{
  "mcpServers": {
    "capy": {
      "command": "capy-mcp"
    }
  }
}
```

14 tools with full CLI parity, tool annotations, and structured output per 2025-03-26 MCP spec.

### Prompting well

Bad: "Fix the CI issue"
Good: "Fix CI for crypto-trading pack. The changeset file is missing. Add a changeset entry for @veto/crypto-trading. Run changeset validation. Reference: PLW-201."

Specific files, specific functions, specific acceptance criteria. Every time.

## Triggers

Keywords that should invoke this skill: "capy", "captain", "build agent", "code review", "quality gates", "delegate", "orchestrate", "send to capy", "capy status", "is it done", "approve", "retry"
