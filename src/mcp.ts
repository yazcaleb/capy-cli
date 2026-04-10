import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createRequire } from "node:module";
import * as api from "./api.js";
import { CapyError } from "./api.js";
import * as config from "./config.js";
import { isThreadId } from "./commands/_shared.js";

const require = createRequire(import.meta.url);
const { version } = require("../package.json");

function pLimit(concurrency: number) {
  let active = 0;
  const queue: (() => void)[] = [];
  return <T>(fn: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const run = () => { active++; fn().then(resolve, reject).finally(() => { active--; queue.length && queue.shift()!(); }); };
      active < concurrency ? run() : queue.push(run);
    });
}

const server = new McpServer({ name: "capy", version });

function err(e: unknown) {
  const error = e instanceof CapyError
    ? { code: e.code, message: e.message }
    : { code: "internal", message: e instanceof Error ? e.message : String(e) };
  return { content: [{ type: "text" as const, text: JSON.stringify({ error }) }], isError: true as const };
}

function text(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
}

function structured(data: Record<string, unknown>) {
  return { structuredContent: data, content: [{ type: "text" as const, text: JSON.stringify(data) }] };
}

// --- Orchestration ---

server.registerTool("capy_captain", {
  description: "Start a Captain thread. Use resume to continue from a previous task with auto-gathered context (diff, CI, reviews).",
  inputSchema: {
    prompt: z.string().optional().describe("What the agent should do. Required unless using resume."),
    model: z.string().optional().describe("Model ID override (default: config defaultModel)"),
    resume: z.string().optional().describe("Task ID to resume from. Auto-gathers context from previous attempt."),
    fix: z.string().optional().describe("Specific fix instructions (used with resume)"),
  },
  outputSchema: {
    threadId: z.string(),
    url: z.string(),
  },
  annotations: { openWorldHint: true },
}, async ({ prompt, model, resume, fix }) => {
  try {
    const cfg = config.load();
    if (resume) {
      const { resumeTask } = await import("./resume.js");
      const r = await resumeTask(resume, { prompt, fix, model, mode: "captain" });
      return structured({ threadId: r.threadId, url: `https://capy.ai/project/${cfg.projectId}/captain/${r.threadId}`, originalTask: r.originalTask, resumed: r.resumed });
    }
    if (!prompt) return err(new Error("prompt is required (or use resume with a task ID)"));
    const data = await api.createThread(prompt, model);
    return structured({ threadId: data.id, url: `https://capy.ai/project/${cfg.projectId}/captain/${data.id}` });
  } catch (e) { return err(e); }
});

server.registerTool("capy_build", {
  description: "Start a Build agent for small isolated tasks. Use resume to continue from a previous task.",
  inputSchema: {
    prompt: z.string().optional().describe("What to build. Required unless using resume."),
    model: z.string().optional().describe("Model ID override"),
    title: z.string().optional().describe("Short task title"),
    resume: z.string().optional().describe("Task ID to resume from."),
    fix: z.string().optional().describe("Specific fix instructions (used with resume)"),
  },
  outputSchema: {
    id: z.string(),
    identifier: z.string(),
    status: z.string(),
    url: z.string(),
  },
  annotations: { openWorldHint: true },
}, async ({ prompt, model, title, resume, fix }) => {
  try {
    const cfg = config.load();
    if (resume) {
      const { resumeTask } = await import("./resume.js");
      const r = await resumeTask(resume, { prompt, fix, model, mode: "build" });
      return structured({ id: r.threadId, identifier: r.originalTask, status: "in_progress", url: `https://capy.ai/project/${cfg.projectId}/tasks/${r.threadId}`, originalTask: r.originalTask });
    }
    if (!prompt) return err(new Error("prompt is required (or use resume with a task ID)"));
    const data = await api.createTask(prompt, model, { title, start: true });
    return structured({ id: data.id, identifier: data.identifier, status: data.status, url: `https://capy.ai/project/${cfg.projectId}/tasks/${data.id}` });
  } catch (e) { return err(e); }
});

server.registerTool("capy_wait", {
  description: "Block until a task or thread reaches terminal state (needs_review, completed, failed, idle, archived)",
  inputSchema: {
    id: z.string().describe("Task or thread ID"),
    timeout: z.number().optional().describe("Timeout in seconds (default 300)"),
    interval: z.number().optional().describe("Poll interval in seconds (default 10)"),
  },
  annotations: { readOnlyHint: true, idempotentHint: true },
}, async ({ id, timeout, interval }) => {
  try {
    const timeoutMs = (timeout || 300) * 1000;
    const intervalMs = Math.max(5, Math.min(interval || 10, 60)) * 1000;
    const isThread = isThreadId(id);
    const terminal = isThread
      ? new Set(["idle", "archived", "completed"])
      : new Set(["needs_review", "archived", "completed", "failed"]);

    const start = Date.now();
    let lastData: any = null;
    while (Date.now() - start < timeoutMs) {
      try {
        lastData = isThread ? await api.getThread(id) : await api.getTask(id);
        if (terminal.has(lastData.status)) return text(lastData);
      } catch (e) {
        if (e instanceof CapyError && ["not_found", "unauthorized", "forbidden", "no_api_key"].includes(e.code)) {
          return err(e);
        }
      }
      await new Promise(r => setTimeout(r, intervalMs));
    }
    return { content: [{ type: "text" as const, text: JSON.stringify({ error: { code: "timeout", message: `Timed out after ${timeout || 300}s`, lastStatus: lastData?.status || "unknown" } }) }], isError: true as const };
  } catch (e) { return err(e); }
});

server.registerTool("capy_review", {
  description: "Run quality gates on a task (pr_exists, pr_open, ci, greptile, threads, tests)",
  inputSchema: {
    id: z.string().describe("Task ID"),
  },
  annotations: { readOnlyHint: true },
}, async ({ id }) => {
  try {
    const qualityEngine = await import("./quality-engine.js");
    const task = await api.getTask(id);
    if (!task.pullRequest?.number) {
      return { content: [{ type: "text" as const, text: JSON.stringify({ error: { code: "no_pr", message: `Task ${task.identifier} has no PR` } }) }], isError: true as const };
    }
    const q = await qualityEngine.check(task);
    return structured({ task: task.identifier, quality: q as unknown as Record<string, unknown> });
  } catch (e) { return err(e); }
});

server.registerTool("capy_approve", {
  description: "Approve a task if quality gates pass. Runs approveCommand hook on success.",
  inputSchema: {
    id: z.string().describe("Task ID"),
    force: z.boolean().optional().describe("Override failing gates"),
  },
  outputSchema: {
    task: z.string(),
    approved: z.boolean(),
    quality: z.object({
      pass: z.boolean(),
      passed: z.number(),
      total: z.number(),
      summary: z.string(),
    }),
  },
  annotations: { openWorldHint: true },
}, async ({ id, force }) => {
  try {
    const qualityEngine = await import("./quality-engine.js");
    const task = await api.getTask(id);
    const cfg = config.load();
    const q = await qualityEngine.check(task);
    const approved = q.pass || !!force;

    if (approved && cfg.approveCommand) {
      try {
        const { execSync } = await import("node:child_process");
        const { shellEscape } = await import("./commands/_shared.js");
        const expanded = cfg.approveCommand
          .replace("{task}", shellEscape(task.identifier || task.id))
          .replace("{title}", shellEscape(task.title || ""))
          .replace("{pr}", shellEscape(String(task.pullRequest?.number || "")));
        execSync(expanded, { timeout: 15000, stdio: "pipe" });
      } catch {}
    }

    return structured({ task: task.identifier, quality: q as unknown as Record<string, unknown>, approved });
  } catch (e) { return err(e); }
});

server.registerTool("capy_retry", {
  description: "Alias for capy_captain with resume. Retry a failed task with auto-gathered context.",
  inputSchema: {
    id: z.string().describe("Task ID to retry"),
    fix: z.string().optional().describe("Specific fix instructions"),
    model: z.string().optional().describe("Model ID override"),
  },
  outputSchema: {
    originalTask: z.string(),
    threadId: z.string(),
    model: z.string(),
  },
  annotations: { openWorldHint: true },
}, async ({ id, fix, model }) => {
  try {
    const { resumeTask } = await import("./resume.js");
    const cfg = config.load();
    const m = model || cfg.defaultModel;
    const r = await resumeTask(id, { fix, model: m, mode: "captain" });
    return structured({ originalTask: r.originalTask, threadId: r.threadId, model: m, resumed: r.resumed });
  } catch (e) { return err(e); }
});

server.registerTool("capy_triage", {
  description: "Actionable triage of all tasks. Categorizes into: merged, ready, needs_pr, stuck, backlog, in_progress. Use brief=true for fast mode (skips diff fetching, ~2x faster).",
  inputSchema: {
    ids: z.array(z.string()).optional().describe("Specific task IDs to triage. Omit for all tasks."),
    brief: z.boolean().optional().describe("Skip diff fetching for speed. Categories based on status + PR state only."),
  },
  annotations: { readOnlyHint: true },
}, async ({ ids, brief }) => {
  try {
    const github = await import("./github.js");
    const cfg = config.load();

    let tasks: any[];
    if (ids?.length) {
      tasks = await Promise.all(ids.map(id => api.getTask(id)));
    } else {
      const data = await api.listTasks({ limit: 100 });
      tasks = data.items || [];
    }

    function categorize(status: string, pr: any, diffStats: any, brief: boolean) {
      if (status === "backlog") return "backlog";
      if (status === "in_progress") return "in_progress";
      if (pr?.state === "merged") return "merged";
      if (pr && pr.state === "open") return "ready";
      if (status === "needs_review" && pr) return "ready";
      if (status === "needs_review" && !pr) return (!brief && (!diffStats || diffStats.files === 0)) ? "stuck" : "needs_pr";
      if (diffStats && diffStats.files > 0 && !pr) return "needs_pr";
      return "stuck";
    }

    let enriched: any[];
    if (brief) {
      enriched = tasks.map((task: any) => {
        if (task.pullRequest?.number && task.pullRequest.state === "closed") {
          const repo = task.pullRequest.repoFullName || cfg.repos[0]?.repoFullName;
          if (repo) {
            const ghPR = github.getPR(repo, task.pullRequest.number);
            if (ghPR) task.pullRequest.state = ghPR.state.toLowerCase();
          }
        }
        const pr = task.pullRequest?.number ? { number: task.pullRequest.number, state: task.pullRequest.state || "?", url: task.pullRequest.url } : null;
        return {
          identifier: task.identifier || task.id,
          title: task.title || "",
          status: task.status,
          labels: task.labels || [],
          category: categorize(task.status, pr, null, true),
          pr,
          diff: null,
          jam: null,
        };
      });
    } else {
      const limit = pLimit(5);
      enriched = await Promise.all(tasks.map((task: any) => limit(async () => {
        const id = task.identifier || task.id;
        const [detail, diff] = await Promise.all([
          task.jams ? task : api.getTask(id).catch(() => task),
          api.getDiff(id).catch(() => null),
        ]);

        if (detail.pullRequest?.number && detail.pullRequest.state === "closed") {
          const repo = detail.pullRequest.repoFullName || cfg.repos[0]?.repoFullName;
          if (repo) {
            const ghPR = github.getPR(repo, detail.pullRequest.number);
            if (ghPR) detail.pullRequest.state = ghPR.state.toLowerCase();
          }
        }

        const lastJam = (detail.jams || []).at(-1);
        const credits = lastJam?.credits;
        const pr = detail.pullRequest?.number ? { number: detail.pullRequest.number, state: detail.pullRequest.state || "?", url: detail.pullRequest.url } : null;
        const diffStats = diff?.stats ? { files: diff.stats.files || 0, additions: diff.stats.additions || 0, deletions: diff.stats.deletions || 0 } : null;

        return {
          identifier: detail.identifier || id,
          title: detail.title || "",
          status: detail.status,
          labels: detail.labels || [],
          category: categorize(detail.status, pr, diffStats, false),
          pr,
          diff: diffStats,
          jam: lastJam ? { model: lastJam.model || "?", status: lastJam.status || "?", credits: { llm: typeof credits === "object" ? (credits?.llm ?? 0) : (credits || 0), vm: typeof credits === "object" ? (credits?.vm ?? 0) : 0 } } : null,
        };
      })));
    }

    const summary = {
      total: enriched.length,
      merged: enriched.filter((t: any) => t.category === "merged").length,
      ready: enriched.filter((t: any) => t.category === "ready").length,
      needs_pr: enriched.filter((t: any) => t.category === "needs_pr").length,
      stuck: enriched.filter((t: any) => t.category === "stuck").length,
      backlog: enriched.filter((t: any) => t.category === "backlog").length,
      in_progress: enriched.filter((t: any) => t.category === "in_progress").length,
    };

    const recs: string[] = [];
    const needsPr = enriched.filter((t: any) => t.category === "needs_pr");
    const stuck = enriched.filter((t: any) => t.category === "stuck");
    const ready = enriched.filter((t: any) => t.category === "ready");
    if (needsPr.length) recs.push(`Create PRs: ${needsPr.map((t: any) => t.identifier).join(", ")}`);
    if (ready.length) recs.push(`Review + approve: ${ready.map((t: any) => t.identifier).join(", ")}`);
    if (stuck.length) recs.push(`Retry or stop: ${stuck.map((t: any) => t.identifier).join(", ")} (no diff produced)`);

    return text({ summary, tasks: enriched, recommendations: recs });
  } catch (e) { return err(e); }
});

// --- Status & monitoring ---

server.registerTool("capy_status", {
  description: "Get task or thread details by ID, or full dashboard (omit ID for dashboard)",
  inputSchema: {
    id: z.string().optional().describe("Task or thread ID. Omit for dashboard."),
  },
  annotations: { readOnlyHint: true, idempotentHint: true },
}, async ({ id }) => {
  try {
    if (id) {
      const isThread = isThreadId(id);
      const data: any = isThread ? await api.getThread(id) : await api.getTask(id);
      if (!isThread && data.pullRequest?.number && data.pullRequest.state === "closed") {
        const { getPR } = await import("./github.js");
        const cfg = config.load();
        const repo = data.pullRequest.repoFullName || cfg.repos[0]?.repoFullName;
        if (repo) {
          const ghPR = getPR(repo, data.pullRequest.number);
          if (ghPR) data.pullRequest.state = ghPR.state.toLowerCase();
        }
      }
      return text(data);
    }
    const [threads, tasks] = await Promise.all([api.listThreads({ limit: 10 }), api.listTasks({ limit: 30 })]);
    return text({ threads: threads.items || [], tasks: tasks.items || [] });
  } catch (e) { return err(e); }
});

server.registerTool("capy_list", {
  description: "List tasks, optionally filtered by status (in_progress, needs_review, backlog, archived)",
  inputSchema: {
    status: z.string().optional().describe("Filter by status"),
    limit: z.number().optional().describe("Max results (default 30)"),
    cursor: z.string().optional().describe("Pagination cursor from previous response"),
  },
  annotations: { readOnlyHint: true, idempotentHint: true },
}, async ({ status, limit, cursor }) => {
  try {
    const data = await api.listTasks({ status, limit: limit || 30, cursor });
    return text({ items: data.items || [], nextCursor: data.nextCursor, hasMore: data.hasMore });
  } catch (e) { return err(e); }
});

server.registerTool("capy_threads", {
  description: "List Captain threads",
  inputSchema: {
    limit: z.number().optional().describe("Max results (default 10)"),
    cursor: z.string().optional().describe("Pagination cursor from previous response"),
  },
  annotations: { readOnlyHint: true, idempotentHint: true },
}, async ({ limit, cursor }) => {
  try {
    const data = await api.listThreads({ limit: limit || 10, cursor });
    return text({ items: data.items || [], nextCursor: data.nextCursor, hasMore: data.hasMore });
  } catch (e) { return err(e); }
});

server.registerTool("capy_diff", {
  description: "View the diff (code changes) from a task",
  inputSchema: {
    id: z.string().describe("Task ID"),
  },
  annotations: { readOnlyHint: true },
}, async ({ id }) => {
  try {
    const data = await api.getDiff(id);
    return text(data);
  } catch (e) { return err(e); }
});

// --- Actions ---

server.registerTool("capy_msg", {
  description: "Send a message to a running task or thread",
  inputSchema: {
    id: z.string().describe("Task or thread ID"),
    text: z.string().describe("Message text"),
    model: z.string().optional().describe("Switch model mid-conversation (threads only)"),
    attachmentUrls: z.array(z.string()).optional().describe("URLs to attach"),
  },
  annotations: { openWorldHint: true },
}, async ({ id, text: msg, model, attachmentUrls }) => {
  try {
    const isThread = isThreadId(id);
    const result = isThread
      ? await api.messageThread(id, msg, { model, attachmentUrls })
      : await api.messageTask(id, msg, { attachmentUrls });
    return text({ id, sent: true, type: isThread ? "thread" : "task", ...(result && typeof result === "object" ? result as Record<string, unknown> : {}) });
  } catch (e) { return err(e); }
});

server.registerTool("capy_stop", {
  description: "Stop a running task or thread",
  inputSchema: {
    id: z.string().describe("Task or thread ID"),
    reason: z.string().optional().describe("Reason for stopping"),
  },
  annotations: { destructiveHint: true },
}, async ({ id, reason }) => {
  try {
    const isThread = isThreadId(id);
    const result = isThread ? await api.stopThread(id) : await api.stopTask(id, reason);
    return text(result);
  } catch (e) { return err(e); }
});

server.registerTool("capy_pr", {
  description: "Create a pull request for a completed task",
  inputSchema: {
    id: z.string().describe("Task ID"),
    title: z.string().optional().describe("PR title override"),
    description: z.string().optional().describe("PR body/description"),
    draft: z.boolean().optional().describe("Create as draft PR"),
  },
  annotations: { openWorldHint: true },
}, async ({ id, title, description, draft }) => {
  try {
    const opts: Record<string, unknown> = {};
    if (title) opts.title = title;
    if (description) opts.description = description;
    if (draft != null) opts.draft = draft;
    const data = await api.createPR(id, opts);
    return text(data);
  } catch (e) { return err(e); }
});

server.registerTool("capy_start", {
  description: "Start a backlog task (resume a task that was created but not yet running)",
  inputSchema: {
    id: z.string().describe("Task ID"),
    model: z.string().optional().describe("Model ID override"),
  },
  annotations: { openWorldHint: true },
}, async ({ id, model }) => {
  try {
    const data = await api.startTask(id, model);
    return text(data);
  } catch (e) { return err(e); }
});

server.registerTool("capy_thread_messages", {
  description: "Read the conversation history of a Captain thread",
  inputSchema: {
    id: z.string().describe("Thread ID"),
    limit: z.number().optional().describe("Max messages (default 50)"),
  },
  annotations: { readOnlyHint: true, idempotentHint: true },
}, async ({ id, limit }) => {
  try {
    const data = await api.getThreadMessages(id, { limit: limit || 50 });
    return text(data.items || []);
  } catch (e) { return err(e); }
});

server.registerTool("capy_re_review", {
  description: "Trigger a fresh Greptile code review on a task's PR",
  inputSchema: {
    id: z.string().describe("Task ID"),
  },
  annotations: { openWorldHint: true },
}, async ({ id }) => {
  try {
    const greptileApi = await import("./greptile.js");
    const task = await api.getTask(id);
    const cfg = config.load();

    if (!task.pullRequest?.number) {
      return { content: [{ type: "text" as const, text: JSON.stringify({ error: { code: "no_pr", message: `Task ${task.identifier} has no PR` } }) }], isError: true as const };
    }

    const repo = task.pullRequest.repoFullName || cfg.repos[0]?.repoFullName || "";
    const prNum = task.pullRequest.number;
    const defaultBranch = cfg.repos.find((r: { repoFullName: string; branch: string }) => r.repoFullName === repo)?.branch || "main";

    const result = await greptileApi.freshReview(repo, prNum, defaultBranch);
    const unaddressed = await greptileApi.getUnaddressedIssues(repo, prNum, defaultBranch);

    return text({ task: task.identifier, pr: prNum, reviewStatus: result?.status || "triggered", unaddressed });
  } catch (e) { return err(e); }
});

server.registerTool("capy_projects", {
  description: "List all projects accessible with the current API key",
  inputSchema: {},
  annotations: { readOnlyHint: true, idempotentHint: true },
}, async () => {
  try {
    const data = await api.listProjectsAuth();
    return text(data);
  } catch (e) { return err(e); }
});

server.registerTool("capy_project", {
  description: "Get project details (repos, task code, config)",
  inputSchema: {
    id: z.string().optional().describe("Project ID (defaults to current project)"),
  },
  outputSchema: {
    id: z.string(),
    name: z.string(),
    taskCode: z.string(),
    repos: z.array(z.object({ repoFullName: z.string(), branch: z.string() })),
    createdAt: z.string().optional(),
    updatedAt: z.string().optional(),
  },
  annotations: { readOnlyHint: true, idempotentHint: true },
}, async ({ id }) => {
  try {
    const data = await api.getProject(id);
    return structured({ id: data.id, name: data.name, taskCode: data.taskCode, repos: data.repos as unknown as Record<string, unknown>[], createdAt: data.createdAt, updatedAt: data.updatedAt });
  } catch (e) { return err(e); }
});

server.registerTool("capy_models", {
  description: "List available AI models",
  inputSchema: {},
  annotations: { readOnlyHint: true, idempotentHint: true },
}, async () => {
  try {
    const data = await api.listModels();
    return text(data.models || []);
  } catch (e) { return err(e); }
});

// --- Warm Pool ---

server.registerTool("capy_pool_status", {
  description: "Get warm pool config and VM status",
  inputSchema: {},
  annotations: { readOnlyHint: true, idempotentHint: true },
}, async () => {
  try {
    const pool = await api.getWarmPool();
    return text(pool);
  } catch (e) { return err(e); }
});

server.registerTool("capy_pool_update", {
  description: "Update warm pool configuration (VM pre-warming)",
  inputSchema: {
    enabled: z.boolean().optional().describe("Enable/disable warm pool"),
    targetSize: z.number().optional().describe("Number of VMs to keep warm"),
    maxAgeMinutes: z.number().optional().describe("Max VM age before recycling"),
    branch: z.string().optional().describe("Branch for pool VMs"),
    setupCommands: z.array(z.string()).optional().describe("Commands to run on VM boot"),
  },
  annotations: { openWorldHint: true },
}, async (params) => {
  try {
    const data = await api.updateWarmPool(params);
    return text(data);
  } catch (e) { return err(e); }
});

server.registerTool("capy_pool_test", {
  description: "Test warm pool VM boot with setup commands",
  inputSchema: {},
  annotations: { openWorldHint: true },
}, async () => {
  try {
    const data = await api.testWarmPool();
    return text(data);
  } catch (e) { return err(e); }
});

server.registerTool("capy_pool_instances", {
  description: "List warm pool VM instances",
  inputSchema: {
    status: z.string().optional().describe("Filter: ready, provisioning, failed, claimed"),
  },
  annotations: { readOnlyHint: true, idempotentHint: true },
}, async ({ status }) => {
  try {
    const data = await api.listWarmPoolInstances({ status });
    return text(data);
  } catch (e) { return err(e); }
});

server.registerTool("capy_pool_clear", {
  description: "Clear all warm pool VMs",
  inputSchema: {
    replenish: z.boolean().optional().describe("Replenish pool after clearing"),
  },
  annotations: { destructiveHint: true },
}, async ({ replenish }) => {
  try {
    const data = await api.clearWarmPool({ replenish });
    return text(data);
  } catch (e) { return err(e); }
});

const transport = new StdioServerTransport();
await server.connect(transport);
