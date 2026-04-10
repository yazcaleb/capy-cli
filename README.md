# capyai

Agent orchestrator with quality gates for [Capy.ai](https://capy.ai). Lets any AI agent delegate coding work to Capy agents, wait for completion, enforce quality, and approve or retry.

Works with Claude Code, Codex, OpenClaw, Poke, or any agent that runs shell commands.

**AI agent?** Read [AGENTS.md](AGENTS.md) and follow every step.

## Install

```bash
npm i -g capyai    # or: bun i -g capyai
capy init          # interactive setup
```

Requires [Bun](https://bun.sh) runtime and [GitHub CLI](https://cli.github.com) (`gh`) for quality gate checks.

## Usage

```bash
# Start work
capy captain "Implement feature X. Files: src/foo.ts. Tests required."
capy build "Fix typo in README"

# Wait for completion (blocks until done)
capy wait <thread-id> --timeout=600

# Monitor
capy status
capy watch <thread-id>

# Review + approve
capy review <task-id>
capy approve <task-id>
capy retry <task-id> --fix="fix the failing test"
```

Every command supports `--json` for machine-readable output.

## Commands

| Command | What it does |
|---------|-------------|
| `capy captain "<prompt>"` | Start Captain thread (primary agent) |
| `capy build "<prompt>"` | Start Build agent (isolated, small tasks) |
| `capy wait <id>` | Block until task/thread reaches terminal state |
| `capy review <id>` | Run quality gates |
| `capy approve <id>` | Approve if all gates pass |
| `capy retry <id> --fix="..."` | Retry with failure context |
| `capy status` | Dashboard of threads and tasks |
| `capy list [status]` | List tasks, optionally filtered |
| `capy get <id>` | Task or thread details |
| `capy diff <id>` | View diff |
| `capy pr <id>` | Create PR for task |
| `capy watch <id>` | Cron poll + notify on completion |
| `capy threads [list\|get\|msg\|stop\|messages]` | Manage Captain threads |
| `capy projects [list\|get]` | List/get projects |
| `capy triage [ids] [--brief]` | Actionable triage with categories + recommendations |
| `capy pool [status\|set\|test\|instances\|clear]` | Manage warm pool VMs |
| `capy models` | List available models |
| `capy config [key] [value]` | Get/set config |

## Quality Gates

`capy review` checks pass/fail gates:

| Gate | What it checks |
|------|---------------|
| `pr_exists` | PR was created |
| `pr_open` | PR is open or merged |
| `ci` | CI checks passing |
| `greptile` | No unaddressed Greptile issues |
| `greptile_check` | Greptile GitHub status check |
| `threads` | No unresolved review threads |
| `tests` | Diff includes test files |

Configure with `capy config quality.reviewProvider greptile|capy|both|none`.

## MCP Server

For agents that prefer MCP over CLI:

```json
{
  "mcpServers": {
    "capy": {
      "command": "capy-mcp"
    }
  }
}
```

25 tools with full API parity, including projects, triage, and warm pool management.

## Config

```bash
capy config defaultModel gpt-5.4
capy config quality.reviewProvider both
capy config notifyCommand "notify-send {text}"
capy config approveCommand "your-hook {task} {pr}"
```

Env vars: `CAPY_API_KEY`, `CAPY_PROJECT_ID`, `CAPY_SERVER`, `CAPY_ENV_FILE`, `GREPTILE_API_KEY`.

Config file: `~/.capy/config.json`.

## Skills.sh

```bash
npx skills add yazcaleb/capy-cli
```

## License

MIT
