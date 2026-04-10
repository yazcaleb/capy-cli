# Agent Setup

You are an AI agent. Follow every step below to install and configure capyai. Do not skip steps. Run every command.

## Step 1: Prerequisites

```bash
command -v bun >/dev/null 2>&1 || { curl -fsSL https://bun.sh/install | bash && export PATH="$HOME/.bun/bin:$PATH"; }
command -v gh >/dev/null 2>&1 || echo "WARN: GitHub CLI (gh) not found. Quality gates need it. Install: https://cli.github.com"
command -v jq >/dev/null 2>&1 || echo "WARN: jq not found. JSON parsing in shell needs it."
```

## Step 2: Install

```bash
bun i -g capyai
```

Verify: `capy --version` should print a version number.

## Step 3: Configure

Ask the user for their Capy API key (`capy_...`). They get it from https://capy.ai/settings/api-keys.

Once you have the key, write the config:

```bash
mkdir -p ~/.capy

# Fetch the user's project ID automatically
export CAPY_API_KEY="<key from user>"
PROJECT_ID=$(curl -s -H "Authorization: Bearer $CAPY_API_KEY" https://capy.ai/api/v1/projects | jq -r '.items[0].id')

cat > ~/.capy/config.json << EOF
{
  "apiKey": "$CAPY_API_KEY",
  "projectId": "$PROJECT_ID",
  "server": "https://capy.ai/api/v1",
  "defaultModel": "gpt-5.4",
  "quality": {
    "reviewProvider": "greptile",
    "requireCI": true,
    "requireTests": true
  }
}
EOF
```

Verify: `capy status --json` should return `{ "threads": [...], "tasks": [...] }`.

If it returns `{ "error": ... }`, the API key or project ID is wrong. Ask the user.

## Step 4: Install skill

```bash
npx skills add yazcaleb/capy-cli
```

This adds the `capy` skill to your skills directory so you have the full command reference available in context.

## Step 5: MCP server (if you support MCP)

Add this to your MCP configuration:

```json
{
  "mcpServers": {
    "capy": {
      "command": "capy-mcp",
      "env": {
        "CAPY_API_KEY": "<same key>",
        "CAPY_PROJECT_ID": "<same project ID>"
      }
    }
  }
}
```

Config file locations:
- Claude Code: `~/.claude.json` (global) or `.claude/settings.json` (project)
- Claude Desktop: `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS)
- Cursor: `.cursor/mcp.json`

14 MCP tools with full CLI parity:

| Tool | What it does | Annotations |
|------|-------------|-------------|
| `capy_captain` | Start Captain thread | openWorld |
| `capy_build` | Start Build agent | openWorld |
| `capy_wait` | Block until done | readOnly, idempotent |
| `capy_review` | Run quality gates | readOnly |
| `capy_approve` | Approve task | openWorld |
| `capy_retry` | Retry with context | openWorld |
| `capy_status` | Task/thread details or dashboard | readOnly, idempotent |
| `capy_list` | List tasks (filterable) | readOnly, idempotent |
| `capy_threads` | List threads | readOnly, idempotent |
| `capy_diff` | View diff | readOnly |
| `capy_msg` | Message task/thread | openWorld |
| `capy_stop` | Stop task/thread | destructive |
| `capy_pr` | Create PR | openWorld |
| `capy_models` | List models | readOnly, idempotent |

Tools with predictable outputs (`capy_captain`, `capy_build`, `capy_review`, `capy_approve`, `capy_retry`) declare `outputSchema` for typed structured content per the 2025-03-26 MCP spec.

If you don't support MCP, skip this step. The CLI works everywhere.

## Step 6: Verify everything

Run all of these. Every one must succeed:

```bash
capy --version
capy status --json
capy models --json
```

You are now fully configured.

---

## How to use capyai

### Delegate work

```bash
capy captain "Implement feature X. Files: src/foo.ts. Tests required." --json
```

Returns `{ "threadId": "...", "url": "..." }`. Save the `threadId`.

### Wait for completion

```bash
capy wait <threadId> --timeout=600 --json
```

Blocks until the thread reaches a terminal state. Returns the full thread object with `tasks` array. Each task has an `identifier` (like `SCO-1`).

### Review quality

```bash
capy review <taskId> --json
```

Returns `{ "task": "SCO-1", "quality": { "pass": true, "passed": 5, "total": 5, "gates": [...] } }`.

Read `quality.pass`. If `true`, approve. If `false`, read `quality.gates` for what failed.

### Approve or retry

```bash
# If quality.pass is true:
capy approve <taskId> --json

# If quality.pass is false:
capy retry <taskId> --fix="describe what to fix" --json
```

`retry` returns `{ "newThread": "..." }`. Wait on that new thread ID, then review again.

### The full loop

```bash
THREAD=$(capy captain "your prompt" --json | jq -r '.threadId')
capy wait "$THREAD" --timeout=600 --json

TASK=$(capy threads get "$THREAD" --json | jq -r '.tasks[0].identifier')
QUALITY=$(capy review "$TASK" --json)
PASS=$(echo "$QUALITY" | jq -r '.quality.pass')

while [ "$PASS" != "true" ]; do
  GATES=$(echo "$QUALITY" | jq -r '.quality.gates[] | select(.pass == false) | .name + ": " + .detail')
  NEW=$(capy retry "$TASK" --fix="Fix these failures: $GATES" --json | jq -r '.newThread')
  capy wait "$NEW" --timeout=600 --json
  TASK=$(capy threads get "$NEW" --json | jq -r '.tasks[0].identifier')
  QUALITY=$(capy review "$TASK" --json)
  PASS=$(echo "$QUALITY" | jq -r '.quality.pass')
done

capy approve "$TASK" --json
```

### Background monitoring

For async fire-and-forget work. Sets a cron job that polls and runs your notification command when done.

```bash
capy watch <threadId>
capy config notifyCommand "<your notification command> {text}"
```

`{text}` is replaced with a summary when the task completes. Examples:
- `openclaw system event --text {text} --mode now`
- `echo {text} >> ~/capy-notifications.log`

List watches: `capy watches --json`. Remove: `capy unwatch <id>`.

### All commands

Every command supports `--json` for structured output. Errors always return `{ "error": { "code": "...", "message": "..." } }`.

| Command | What it does |
|---------|-------------|
| `capy captain "<prompt>"` | Start Captain thread |
| `capy build "<prompt>"` | Start Build agent (small isolated tasks) |
| `capy wait <id> --timeout=N` | Block until terminal state |
| `capy review <id>` | Run quality gates (pass/fail) |
| `capy approve <id>` | Approve if gates pass |
| `capy retry <id> --fix="..."` | Retry with context |
| `capy status` | Dashboard |
| `capy list [status]` | List tasks |
| `capy get <id>` | Task or thread details |
| `capy diff <id>` | View diff |
| `capy pr <id>` | Create PR |
| `capy watch <id>` | Cron poll + notify |
| `capy threads list` | List threads |
| `capy threads get <id>` | Thread details |
| `capy threads msg <id> "<text>"` | Message a thread |
| `capy config [key] [value]` | Get/set config |
| `capy models` | List available models |

### Prompting tips

Bad: `"Fix the CI issue"`

Good: `"Fix CI for crypto-trading pack. The changeset file is missing. Add a changeset entry for @veto/crypto-trading. Run changeset validation. Reference: PLW-201."`

Always include: specific files, specific functions, acceptance criteria, references to related tasks/issues.
