---
name: capy
description: Orchestrate Capy.ai coding agents with quality gates. Delegate coding work, wait for completion, review quality, approve or retry.
metadata:
  author: yazcaleb
  version: "0.6.0"
---

# capy

You orchestrate Capy.ai coding agents. You start them, wait for them, gate their output on quality, then approve or retry. This skill makes you a 10x Capy orchestrator.

## When to use this skill

Use capy when the user wants to:
- Delegate coding work to an AI agent (not do it locally)
- Check on tasks running on Capy (status, triage, review)
- Approve, retry, or stop Capy tasks
- Create PRs for completed Capy work
- Manage Capy projects, warm pool VMs, or configuration

Do NOT use capy when:
- The user wants you to write code yourself (just write it)
- The user is talking about a different CI/CD system
- The task is too small to delegate (a one-line fix, a config change)

## Core objects

Understand these three objects before doing anything.

**Thread** — A Captain session. This is your primary interface. You give it a prompt, it plans and may spawn multiple tasks. Threads have long opaque IDs (UUIDs). Terminal states: `idle`, `archived`, `completed`. Start threads with `capy captain`. Use Captain for almost everything.

**Task** — A single unit of coding work. Has a short identifier like `SCO-15`. A task produces a diff (code changes) and optionally a pull request. Terminal states: `needs_review`, `archived`, `completed`, `failed`. Captain spawns tasks automatically. You can also start standalone tasks with `capy build` for small, isolated work where Captain is overkill (a one-file fix, a config change).

**Jam** — An execution run inside a task. Each jam has a model, a status, and credit usage. A task can have multiple jams (one per retry). When `jam.status` is `"idle"` and credits are zero, that jam is finished. The task is done working. You cannot send it more messages.

**Lifecycle:**

```
[you] capy captain (default) or capy build (small isolated tasks)
  → [capy agent] in_progress (writing code, running tests)
  → [capy agent] needs_review (agent stopped, diff may exist)
  → [you] check diff, create PR, run quality gates
  → [you] approve OR retry
```

`needs_review` means the agent finished working. It does NOT mean the code is ready to merge. You must still check the diff, create a PR, review quality gates, and approve.

## Decision tree

When you encounter a task, look at its status and act accordingly. Do exactly one thing.

**If status is `in_progress`:**
→ Wait for it. `capy wait <id> --timeout=600 --json`

**If status is `needs_review`:**
1. Check if it has a diff: `capy get <id> --json` and look at `pullRequest` field
2. If no diff was produced (no `pullRequest`, and `capy diff <id> --json` returns `stats.files: 0`):
   → Task is stuck. Resume with instructions: `capy captain --resume <id> --fix="describe what went wrong" --json`
3. If diff exists but no PR:
   → Create a PR first: `capy pr <id> --json`
   → Then review: `capy review <id> --json`
4. If diff exists and PR exists:
   → Review: `capy review <id> --json`
   → If `quality.pass` is true → `capy approve <id> --json`
   → If `quality.pass` is false → check which gates failed (see Quality Gates section)

**If status is `backlog`:**
→ Start it. `capy start <id> --json`

**If status is `failed`:**
→ Resume. `capy captain --resume <id> --fix="..." --json`

**If status is `archived`:**
→ Ignore. This task is dead.

**If PR state is `merged`:**
→ Done. Nothing to do.

## Guardrails

These are the mistakes agents make. Do not make them.

1. **Never message a task with idle jams.** If the last jam has `status: "idle"` and zero credits, the task is finished. It cannot receive messages. Sending `capy msg` will appear to succeed but nothing happens. If you need to change something, use `capy retry` to start a new attempt.

2. **Always check for existing work before starting a new Captain thread.** Run `capy triage --brief --json` or `capy list --json` first. If a task or thread already exists for the same work (in any state: `in_progress`, `needs_review`, `backlog`, `stuck`), resume it instead of creating a new thread. Use `capy captain --resume <id> --fix="..."` to resume stuck/failed tasks, `capy wait <id>` for in-progress ones, `capy pr <id>` for ones needing a PR. Only start a new Captain thread when no related work exists. Creating duplicate threads throws away existing progress and burns credits.

3. **Never call `capy review` on a task with no PR.** It will fail with `error.code: "no_pr"`. Always create the PR first with `capy pr <id> --json`, then review.

4. **Never retry infinitely.** Cap retries at 3 attempts. After 3 failures, stop the task with `capy stop <id>` and tell the user. Each retry costs LLM and VM credits.

5. **If Greptile says "Review still processing", wait and re-check.** Do NOT retry the task. The code is fine, the review just hasn't finished. Wait 60 seconds, then run `capy review <id> --json` again.

6. **Captain threads can spawn multiple tasks.** After `capy wait` on a thread, check ALL tasks in the response, not just `tasks[0]`. Review and approve each one.

7. **The Capy API reports merged PRs as "closed".** The CLI cross-references with GitHub to show the real state. Trust the CLI output.

## Workflow: Start new work

Before creating a new Captain thread, check if related work already exists. If it does, resume it (see Decision tree). Only start new work when nothing related is in flight.

```bash
# 0. Check for existing related work first
capy triage --brief --json
# If something related exists → use retry/wait/pr on that task instead of starting new

# 1. Start a Captain thread (the default for almost everything)
RESULT=$(capy captain "We need feature X implemented. Make sure tests pass and CI is green." --json)
THREAD_ID=$(echo "$RESULT" | jq -r '.id')

# 2. Wait for completion (use 600s for Captain, 300s for Build)
WAIT_RESULT=$(capy wait "$THREAD_ID" --timeout=600 --json)

# 3. Check if wait timed out
if echo "$WAIT_RESULT" | jq -e '.error' > /dev/null 2>&1; then
  echo "Timed out. Last status: $(echo "$WAIT_RESULT" | jq -r '.error.lastStatus')"
  # Decide: wait longer, or stop the thread
  exit 1
fi

# 4. Get task identifiers from the thread
TASKS=$(echo "$WAIT_RESULT" | jq -r '.tasks[].identifier')

# 5. For each task: create PR if needed, review, approve/retry
for TASK in $TASKS; do
  # Check if PR exists
  HAS_PR=$(capy get "$TASK" --json | jq -r '.pullRequest.number // empty')
  if [ -z "$HAS_PR" ]; then
    capy pr "$TASK" --json
  fi

  # Review quality
  QUALITY=$(capy review "$TASK" --json)
  PASS=$(echo "$QUALITY" | jq -r '.quality.pass')

  # Resume loop (max 3)
  ATTEMPTS=0
  while [ "$PASS" != "true" ] && [ "$ATTEMPTS" -lt 3 ]; do
    FAILING=$(echo "$QUALITY" | jq -r '.quality.gates[] | select(.pass == false) | .name + ": " + .detail')
    RESUME=$(capy captain --resume "$TASK" --fix="Fix these failures: $FAILING" --json)
    RESUME_THREAD=$(echo "$RESUME" | jq -r '.threadId')

    capy wait "$RESUME_THREAD" --timeout=600 --json
    TASK=$(capy threads get "$RESUME_THREAD" --json | jq -r '.tasks[-1].identifier')

    HAS_PR=$(capy get "$TASK" --json | jq -r '.pullRequest.number // empty')
    [ -z "$HAS_PR" ] && capy pr "$TASK" --json

    QUALITY=$(capy review "$TASK" --json)
    PASS=$(echo "$QUALITY" | jq -r '.quality.pass')
    ATTEMPTS=$((ATTEMPTS + 1))
  done

  if [ "$PASS" = "true" ]; then
    capy approve "$TASK" --json
  else
    echo "Task $TASK failed after $ATTEMPTS retries"
  fi
done
```

## Workflow: Triage existing work

When the user asks "what's the status" or you need to check on existing tasks:

```bash
# Fast overview (no diff fetching, 2x faster, good enough for status checks)
capy triage --brief --json

# Full detail with diff stats (use when you need to decide actions)
capy triage --json

# Check specific tasks
capy triage SCO-15,SCO-24 --json
```

Triage returns:
```json
{
  "summary": { "total": 26, "merged": 7, "ready": 2, "needs_pr": 11, "stuck": 3, "backlog": 3, "in_progress": 0 },
  "tasks": [{ "identifier": "SCO-15", "category": "needs_pr", "title": "...", "pr": null, "diff": { "files": 5, "additions": 494 } }],
  "recommendations": ["Create PRs: SCO-15, SCO-24", "Retry or stop: SCO-21, SCO-22"]
}
```

Map categories to actions:
- `in_progress` → wait
- `needs_pr` → `capy pr <id>` then review
- `ready` → `capy review <id>` then approve/retry
- `stuck` → `capy captain --resume <id> --fix="..."` or `capy stop <id>`
- `backlog` → `capy start <id>` if the user wants it running
- `merged` → done, ignore

## Quality gates

`capy review <id> --json` returns `quality.pass` (boolean) and `quality.gates` (array of gate results).

| Gate | Checks | When it fails, do this |
|------|--------|----------------------|
| `pr_exists` | A PR was created | Run `capy pr <id> --json` first |
| `pr_open` | PR is open or merged | PR was closed. Check why. May need a new PR. |
| `ci` | CI checks are green | Resume: `capy captain --resume <id> --fix="CI failing: <list failing checks>"` |
| `greptile` | No unaddressed code review issues | If "still processing": wait 60s, re-review. If issues listed: resume with issues in `--fix` |
| `threads` | No unresolved GitHub review threads | Resume with the unresolved comments in `--fix` |
| `tests` | Diff includes test files | Resume: `capy captain --resume <id> --fix="Add tests for the changes"` |

## Commands reference

All commands support `--json` for structured output. All errors return `{ "error": { "code": "...", "message": "..." } }`.

### Start work

```bash
capy captain "<prompt>" --json                        # → { id, projectId, status, title, url, createdAt }
capy captain --resume <id> --fix="..." --json         # → { originalTask, threadId, resumed, model }
capy build "<prompt>" --json                          # → { id, identifier, status, url, createdAt }
capy build --resume <id> --fix="..." --json           # → { originalTask, newTask, model }
capy retry <id> --fix="..." --json                    # → alias for captain --resume
```

`--resume` messages the existing Captain thread directly (Captain already has full context). If the task has no parent thread (standalone Build), it falls back to creating a new thread with gathered context. If the previous task is still `in_progress`, it stops it first.

Model shortcuts: `--opus`, `--sonnet`, `--mini`, `--fast`, `--kimi`, `--gemini`, `--grok`, `--qwen`, or `--model=<id>`.

### Wait and monitor

```bash
capy wait <id> --timeout=600 --json     # → full object on success, { error: { code: "timeout", lastStatus } } on timeout
capy triage [ids] [--brief] --json      # → { summary, tasks, recommendations }
capy get <id> --json                    # → full task or thread object
capy list [status] [--limit=N] --json   # → { items, nextCursor, hasMore }
capy diff <id> --json                   # → { stats: { files, additions, deletions }, files: [...] }
capy status --json                      # → { threads, tasks, watches }
```

### Take action

```bash
capy pr <id> [--draft] [--description="..."] --json   # → { url, number, title }
capy review <id> --json                                # → { task, quality: { pass, passed, total, gates, summary }, diff, unaddressed, reviewProvider }
capy approve <id> [--force] --json                     # → { task, quality, approved }
capy start <id> --json                                 # → task object
capy stop <id> --json                                  # → task/thread object
capy msg <id> "<text>" --json                          # → { id, sent: true }
capy re-review <id> --json                             # → triggers fresh Greptile review
```

### Threads

```bash
capy threads list [--limit=N] --json    # → { items, nextCursor, hasMore }
capy threads get <id> --json            # → thread with tasks[] and pullRequests[]
capy threads msg <id> "<text>" --json   # → message result
capy threads stop <id> --json           # → stop result
capy threads messages <id> --json       # → conversation history
```

### Admin

```bash
capy projects --json                    # → list of projects
capy projects get [id] --json           # → project details (defaults to current)
capy models --json                      # → available models
capy config [key] [value]               # → get/set config
capy pool [status|set|test|instances|instance|clear]  # → warm pool management
```

## Prompting tips

You should almost always use Captain. It has full codebase context and plans its own approach. Tell it what to accomplish, not how. Link the issue, set the quality bar, get out of its way.

Bad (over-specifying): `"Fix CI for crypto-trading pack. The changeset file is missing. Add a changeset entry for @veto/crypto-trading with patch bump. Run 'npx changeset status' to validate. Files: packages/crypto-trading/."`

Good: `"CI is failing on the crypto-trading pack, missing changeset. Fix it. Reference: PLW-201. Don't come back until CI is green and tests pass."`

Good: `"https://linear.app/plaw/issue/PLW-201 — get this done. All tests passing, CI green, code review clean."`

Captain prompts should include:
- What the problem or goal is (natural language)
- A link to the issue if one exists (GitHub, Linear)
- The quality bar ("tests pass", "CI green", "code review clean")

Do NOT tell Captain which files to touch, which commands to run, or how to implement. It has the codebase. It figures that out.

**Build** is the exception, not the rule. It has codebase context too, but it works on a single task and can't orchestrate like Captain does. Use it for small one-off work where Captain is overkill.

## Triggers

Keywords: capy, captain, build agent, quality gates, delegate coding, orchestrate agents, send to capy, approve task, retry task, triage tasks, check capy status, review PR, what's the status
