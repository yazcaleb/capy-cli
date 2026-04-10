import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createRequire } from "node:module";
import * as api from "./api.js";
import { CapyError } from "./api.js";
import * as config from "./config.js";

const require = createRequire(import.meta.url);
const { version } = require("../package.json");

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

function isThreadId(id: string): boolean {
  return id.length > 20 || (id.length > 10 && !id.match(/^[A-Z]+-\d+$/));
}

// --- Orchestration ---

server.registerTool("capy_captain", {
  description: "Start a Captain thread to delegate coding work to a Capy agent",
  inputSchema: {
    prompt: z.string().describe("What the agent should do. Be specific: files, functions, acceptance criteria."),
    model: z.string().optional().describe("Model ID override (default: config defaultModel)"),
  },
  outputSchema: {
    threadId: z.string(),
    url: z.string(),
  },
  annotations: { openWorldHint: true },
}, async ({ prompt, model }) => {
  try {
    const cfg = config.load();
    const data = await api.createThread(prompt, model);
    return structured({ threadId: data.id, url: `https://capy.ai/project/${cfg.projectId}/captain/${data.id}` });
  } catch (e) { return err(e); }
});

server.registerTool("capy_build", {
  description: "Start a Build agent for small isolated tasks (single-file fixes, scripts)",
  inputSchema: {
    prompt: z.string().describe("What to build. Be specific."),
    model: z.string().optional().describe("Model ID override"),
    title: z.string().optional().describe("Short task title"),
  },
  outputSchema: {
    id: z.string(),
    identifier: z.string(),
    status: z.string(),
  },
  annotations: { openWorldHint: true },
}, async ({ prompt, model, title }) => {
  try {
    const data = await api.createTask(prompt, model, { title, start: true });
    return structured({ id: data.id, identifier: data.identifier, status: data.status });
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
    while (Date.now() - start < timeoutMs) {
      const data = isThread ? await api.getThread(id) : await api.getTask(id);
      if (terminal.has(data.status)) return text(data);
      await new Promise(r => setTimeout(r, intervalMs));
    }
    return { content: [{ type: "text" as const, text: JSON.stringify({ error: { code: "timeout", message: `Timed out after ${timeout || 300}s` } }) }], isError: true as const };
  } catch (e) { return err(e); }
});

server.registerTool("capy_review", {
  description: "Run quality gates on a task (pr_exists, pr_open, ci, greptile, threads, tests)",
  inputSchema: {
    id: z.string().describe("Task ID"),
  },
  outputSchema: {
    task: z.string(),
    quality: z.object({
      pass: z.boolean(),
      passed: z.number(),
      total: z.number(),
      summary: z.string(),
    }),
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
        const { execFileSync } = await import("node:child_process");
        const parts = cfg.approveCommand
          .replace("{task}", task.identifier || task.id)
          .replace("{title}", task.title || "")
          .replace("{pr}", String(task.pullRequest?.number || ""))
          .split(/\s+/);
        execFileSync(parts[0], parts.slice(1), { encoding: "utf8", timeout: 15000, stdio: "pipe" });
      } catch {}
    }

    return structured({ task: task.identifier, quality: q as unknown as Record<string, unknown>, approved });
  } catch (e) { return err(e); }
});

server.registerTool("capy_retry", {
  description: "Retry a failed task with context from previous attempt. Creates a new Captain thread.",
  inputSchema: {
    id: z.string().describe("Task ID to retry"),
    fix: z.string().optional().describe("Specific fix instructions"),
    model: z.string().optional().describe("Model ID override"),
  },
  outputSchema: {
    originalTask: z.string(),
    newThread: z.string(),
    model: z.string(),
  },
  annotations: { openWorldHint: true },
}, async ({ id, fix, model }) => {
  try {
    const task = await api.getTask(id);
    const cfg = config.load();

    let context = `Previous attempt: ${task.identifier} "${task.title}" [${task.status}]\n`;
    try {
      const d = await api.getDiff(id);
      if (d.stats?.files && d.stats.files > 0) {
        context += `\nPrevious diff: +${d.stats.additions} -${d.stats.deletions} in ${d.stats.files} files\n`;
      }
    } catch {}

    let retryPrompt = `RETRY: This is a retry of a previous attempt that had issues.\n\nOriginal task: ${task.prompt || task.title}\n\n--- CONTEXT ---\n${context}\n`;
    if (fix) retryPrompt += `--- FIX ---\n${fix}\n\n`;
    retryPrompt += `Fix the issues. Include tests. Run tests before completing.\n`;

    if (task.status === "in_progress") {
      await api.stopTask(id, "Retrying with fixes");
    }

    const m = model || cfg.defaultModel;
    const data = await api.createThread(retryPrompt, m);
    return structured({ originalTask: task.identifier, newThread: data.id, model: m });
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
