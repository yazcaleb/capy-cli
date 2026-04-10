import { defineCommand } from "citty";
import { jsonArg } from "./_shared.js";

export const watch = defineCommand({
  meta: { name: "watch", description: "Poll + notify on completion" },
  args: {
    id: { type: "positional", description: "Task or thread ID", required: true },
    interval: { type: "string", description: "Poll interval in minutes (1-30)", default: "3" },
    ...jsonArg,
  },
  async run({ args }) {
    const w = await import("../watch.js");
    const config = await import("../config.js");
    const fmt = await import("../output.js");

    const interval = Math.max(1, Math.min(parseInt(args.interval) || config.load().watchInterval, 30));
    const type = (args.id.length > 20 || (args.id.length > 10 && !args.id.match(/^[A-Z]+-\d+$/))) ? "thread" : "task";
    const added = w.add(args.id, type, interval);

    if (args.json) { fmt.out({ id: args.id, type, interval, added }); return; }
    if (added) {
      console.log(`Watching ${args.id} (${type}) every ${interval}min. Will notify when done.`);
    } else {
      console.log(`Already watching ${args.id}.`);
    }
  },
});

export const unwatch = defineCommand({
  meta: { name: "unwatch", description: "Stop watching" },
  args: {
    id: { type: "positional", description: "Task or thread ID", required: true },
    ...jsonArg,
  },
  async run({ args }) {
    const w = await import("../watch.js");
    const fmt = await import("../output.js");

    w.remove(args.id);
    if (args.json) { fmt.out({ id: args.id, status: "removed" }); return; }
    console.log(`Stopped watching ${args.id}.`);
  },
});

export const watches = defineCommand({
  meta: { name: "watches", description: "List active watches" },
  args: { ...jsonArg },
  async run({ args }) {
    const w = await import("../watch.js");
    const fmt = await import("../output.js");

    const entries = w.list();
    if (args.json) { fmt.out(entries); return; }
    if (!entries.length) { console.log("No active watches."); return; }
    entries.forEach(e => console.log(`${fmt.pad(e.id.slice(0, 20), 22)} type=${e.type}  every ${e.intervalMin}min  since ${e.created}`));
  },
});

export const wait = defineCommand({
  meta: { name: "wait", description: "Block until task/thread reaches terminal state" },
  args: {
    id: { type: "positional", description: "Task or thread ID", required: true },
    timeout: { type: "string", description: "Timeout in seconds", default: "300" },
    interval: { type: "string", description: "Poll interval in seconds", default: "10" },
    ...jsonArg,
  },
  async run({ args }) {
    const api = await import("../api.js");
    const fmt = await import("../output.js");

    const timeoutMs = Math.max(10, parseInt(args.timeout) || 300) * 1000;
    const intervalMs = Math.max(5, Math.min(parseInt(args.interval) || 10, 60)) * 1000;
    const isThread = args.id.length > 20 || (args.id.length > 10 && !args.id.match(/^[A-Z]+-\d+$/));
    const terminalTask = new Set(["needs_review", "archived", "completed", "failed"]);
    const terminalThread = new Set(["idle", "archived", "completed"]);
    const terminal = isThread ? terminalThread : terminalTask;

    const start = Date.now();
    if (!args.json) process.stderr.write(`Waiting for ${args.id} (${isThread ? "thread" : "task"})...`);

    while (Date.now() - start < timeoutMs) {
      const data = isThread ? await api.getThread(args.id) : await api.getTask(args.id);
      if (terminal.has(data.status)) {
        if (args.json) { fmt.out(data); return; }
        console.log(`\n${isThread ? "Thread" : "Task"} ${data.status}.`);
        return;
      }
      if (!args.json) process.stderr.write(".");
      await new Promise(r => setTimeout(r, intervalMs));
    }

    if (args.json) { fmt.out({ error: { code: "timeout", message: `Timed out after ${args.timeout}s` } }); process.exit(1); }
    console.error(`\ncapy: timed out after ${args.timeout}s`);
    process.exit(1);
  },
});

export const _poll = defineCommand({
  meta: { name: "_poll", description: "Internal cron poll", hidden: true },
  args: {
    id: { type: "positional", description: "ID", required: true },
    type: { type: "positional", description: "task or thread" },
  },
  async run({ args }) {
    const api = await import("../api.js");
    const w = await import("../watch.js");

    const type = args.type || "task";

    if (type === "thread") {
      const data = await api.getThread(args.id);
      if (data.status === "idle" || data.status === "archived") {
        const taskLines = (data.tasks || []).map(t => `  ${t.identifier}: ${t.title} [${t.status}]`).join("\n");
        const prLines = (data.pullRequests || []).map(p => `  PR#${p.number}: ${p.url} [${p.state}]`).join("\n");
        let msg = `[Capy] Captain thread finished.\nTitle: ${data.title || "(untitled)"}\nStatus: ${data.status}`;
        if (taskLines) msg += `\n\nTasks:\n${taskLines}`;
        if (prLines) msg += `\n\nPRs:\n${prLines}`;
        msg += `\n\nRun: capy review <task-id> for each task, then capy approve <task-id> if quality passes.`;
        w.notify(msg);
        w.remove(args.id);
      }
      return;
    }

    const data = await api.getTask(args.id);
    if (data.status === "needs_review" || data.status === "archived") {
      let msg = `[Capy] Task ${data.identifier} ready.\nTitle: ${data.title}\nStatus: ${data.status}`;
      if (data.pullRequest) msg += `\nPR: ${data.pullRequest.url || "#" + data.pullRequest.number}`;
      msg += `\n\nRun: capy review ${data.identifier}, then capy approve ${data.identifier} if quality passes.`;
      w.notify(msg);
      w.remove(args.id);
    }
  },
});
