# capyai

Agent orchestrator with quality gates for [Capy.ai](https://capy.ai).

Works with Claude Code, Codex, OpenClaw, Poke, or any AI agent that can run shell commands.

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

Requires [Bun](https://bun.sh) runtime and GitHub CLI (`gh`) for quality gate checks.

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

## For Agents

The core orchestration loop:

```bash
capy captain "precise prompt" --json        # start work
capy wait <thread-id> --timeout=600 --json  # block until done
capy review <task-id> --json                # check quality gates
capy approve <task-id> --json               # approve if gates pass
capy retry <task-id> --fix="..." --json     # or retry with context
```

### MCP Server

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

### Skills.sh

```bash
npx skills add yazcaleb/capy-cli
```

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

Configure via `capy config quality.reviewProvider greptile|capy|both|none`.

## Config

```bash
capy config defaultModel gpt-5.4
capy config quality.reviewProvider both
capy config notifyCommand "notify-send {text}"
```

Env vars: `CAPY_API_KEY`, `CAPY_PROJECT_ID`, `CAPY_SERVER`, `CAPY_ENV_FILE`, `GREPTILE_API_KEY`.

## License

MIT
