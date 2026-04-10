import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createRequire } from "node:module";
import * as api from "./api.js";
import * as config from "./config.js";

const require = createRequire(import.meta.url);
const { version } = require("../package.json");

const server = new McpServer({
  name: "capy",
  version,
});

server.tool("capy_captain", "Start a Captain thread to delegate coding work", {
  prompt: z.string().describe("What the agent should do. Be specific: files, functions, acceptance criteria."),
  model: z.string().optional().describe("Model ID override"),
}, async ({ prompt, model }) => {
  const cfg = config.load();
  const data = await api.createThread(prompt, model);
  return { content: [{ type: "text", text: JSON.stringify({ threadId: data.id, url: `https://capy.ai/project/${cfg.projectId}/captain/${data.id}` }) }] };
});

server.tool("capy_status", "Get task or thread status, or full dashboard", {
  id: z.string().optional().describe("Task or thread ID. Omit for dashboard."),
}, async ({ id }) => {
  if (id) {
    const isThread = id.length > 20 || (id.length > 10 && !id.match(/^[A-Z]+-\d+$/));
    const data = isThread ? await api.getThread(id) : await api.getTask(id);
    return { content: [{ type: "text", text: JSON.stringify(data) }] };
  }
  const [threads, tasks] = await Promise.all([api.listThreads({ limit: 10 }), api.listTasks({ limit: 30 })]);
  return { content: [{ type: "text", text: JSON.stringify({ threads: threads.items || [], tasks: tasks.items || [] }) }] };
});

server.tool("capy_review", "Run quality gates on a task", {
  id: z.string().describe("Task ID"),
}, async ({ id }) => {
  const qualityEngine = await import("./quality-engine.js");
  const task = await api.getTask(id);
  if (!task.pullRequest?.number) {
    return { content: [{ type: "text", text: JSON.stringify({ error: "no_pr", task: task.identifier }) }] };
  }
  const q = await qualityEngine.check(task);
  return { content: [{ type: "text", text: JSON.stringify({ task: task.identifier, quality: q }) }] };
});

server.tool("capy_approve", "Approve a task if quality gates pass. Runs the configured approveCommand hook on success.", {
  id: z.string().describe("Task ID"),
  force: z.boolean().optional().describe("Override failing gates"),
}, async ({ id, force }) => {
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

  return { content: [{ type: "text", text: JSON.stringify({ task: task.identifier, quality: q, approved }) }] };
});

server.tool("capy_retry", "Retry a failed task with context from previous attempt", {
  id: z.string().describe("Task ID to retry"),
  fix: z.string().optional().describe("Specific fix instructions"),
  model: z.string().optional().describe("Model ID override"),
}, async ({ id, fix, model }) => {
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

  const data = await api.createThread(retryPrompt, model || cfg.defaultModel);
  return { content: [{ type: "text", text: JSON.stringify({ originalTask: task.identifier, newThread: data.id, model: model || cfg.defaultModel }) }] };
});

server.tool("capy_wait", "Poll until a task or thread reaches terminal state", {
  id: z.string().describe("Task or thread ID"),
  timeout: z.number().optional().describe("Timeout in seconds (default 300)"),
  interval: z.number().optional().describe("Poll interval in seconds (default 10)"),
}, async ({ id, timeout, interval }) => {
  const timeoutMs = (timeout || 300) * 1000;
  const intervalMs = Math.max(5, Math.min(interval || 10, 60)) * 1000;
  const isThread = id.length > 20 || (id.length > 10 && !id.match(/^[A-Z]+-\d+$/));
  const terminalTask = new Set(["needs_review", "archived", "completed", "failed"]);
  const terminalThread = new Set(["idle", "archived", "completed"]);
  const terminal = isThread ? terminalThread : terminalTask;

  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const data = isThread ? await api.getThread(id) : await api.getTask(id);
    if (terminal.has(data.status)) {
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return { content: [{ type: "text", text: JSON.stringify({ error: { code: "timeout", message: `Timed out after ${timeout || 300}s` } }) }] };
});

const transport = new StdioServerTransport();
await server.connect(transport);
