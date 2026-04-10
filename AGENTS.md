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

## Step 4: Load the operating manual

`skills/capy/SKILL.md` is the full operating manual: object model, decision trees, workflows, guardrails, commands. You need it in your context.

```bash
npx skills add yazcaleb/capy-cli
```

If skills.sh doesn't work in your setup, copy the file to your persistent skills or memory folder, or read it at session start:
```bash
cp skills/capy/SKILL.md <your-agent-skills-dir>/capy.md
```

## Step 5: MCP server (optional)

If your agent supports MCP, add the server for structured tool calls instead of CLI. Both have full API parity.

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

25 MCP tools with full API parity:

| Tool | What it does | Annotations |
|------|-------------|-------------|
| `capy_captain` | Start Captain thread | openWorld |
| `capy_build` | Start Build agent | openWorld |
| `capy_start` | Start/resume a backlog task | openWorld |
| `capy_wait` | Block until done | readOnly, idempotent |
| `capy_review` | Run quality gates | readOnly |
| `capy_approve` | Approve task | openWorld |
| `capy_retry` | Retry with context | openWorld |
| `capy_re_review` | Trigger Greptile re-review | openWorld |
| `capy_status` | Task/thread details or dashboard | readOnly, idempotent |
| `capy_list` | List tasks (filterable, paginated) | readOnly, idempotent |
| `capy_threads` | List threads (paginated) | readOnly, idempotent |
| `capy_thread_messages` | Read thread conversation history | readOnly, idempotent |
| `capy_diff` | View diff | readOnly |
| `capy_msg` | Message task/thread (supports attachments, model switch) | openWorld |
| `capy_stop` | Stop task/thread | destructive |
| `capy_pr` | Create PR (title, description, draft) | openWorld |
| `capy_models` | List models | readOnly, idempotent |
| `capy_pool_status` | Warm pool config + VM status | readOnly, idempotent |
| `capy_pool_update` | Update warm pool config | openWorld |
| `capy_pool_test` | Test VM boot with setup commands | openWorld |
| `capy_pool_instances` | List warm pool VMs | readOnly, idempotent |
| `capy_pool_clear` | Clear/refresh warm pool | destructive |
| `capy_projects` | List all projects | readOnly, idempotent |
| `capy_project` | Get project details (repos, code, config) | readOnly, idempotent |
| `capy_triage` | Actionable triage with categories + recs (brief mode available) | readOnly |

If you don't use MCP, skip this step. The CLI from Step 2 works everywhere with `--json`.

## Step 6: Verify everything

Run all of these. Every one must succeed:

```bash
capy --version
capy status --json
capy models --json
```

You are now fully configured.

## Usage

Read `skills/capy/SKILL.md`. That's it. Everything you need to orchestrate Capy agents is in that file.
