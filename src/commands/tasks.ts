import { defineCommand } from "citty";
import { modelArgs, jsonArg, resolveModel } from "./_shared.js";

export const list = defineCommand({
  meta: { name: "list", description: "List tasks", alias: "ls" },
  args: {
    status: { type: "positional", required: false, description: "Filter by status" },
    limit: { type: "string", description: "Max results (default 30)" },
    cursor: { type: "string", description: "Pagination cursor from previous response" },
    ...jsonArg,
  },
  async run({ args }) {
    const api = await import("../api.js");
    const fmt = await import("../output.js");

    const data = await api.listTasks({ status: args.status, limit: args.limit ? parseInt(args.limit) : undefined, cursor: args.cursor });
    if (args.json) { fmt.out({ items: data.items || [], nextCursor: data.nextCursor, hasMore: data.hasMore }); return; }
    if (!data.items?.length) { console.log("No tasks."); return; }
    fmt.table(["ID", "STATUS", "TITLE", "PR"], data.items.map(t => [
      t.identifier,
      t.status,
      (t.title || "").slice(0, 45),
      t.pullRequest ? `PR#${t.pullRequest.number} [${t.pullRequest.state}]` : "\u2014",
    ]));
  },
});

export const get = defineCommand({
  meta: { name: "get", description: "Task details", alias: "show" },
  args: {
    id: { type: "positional", description: "Task ID", required: true },
    ...jsonArg,
  },
  async run({ args }) {
    const api = await import("../api.js");
    const config = await import("../config.js");
    const github = await import("../github.js");
    const fmt = await import("../output.js");
    const { log } = await import("@clack/prompts");

    const data = await api.getTask(args.id);

    // Capy API reports merged PRs as "closed". Cross-ref with GitHub for real state.
    if (data.pullRequest?.number && data.pullRequest.state === "closed") {
      const repo = data.pullRequest.repoFullName || config.load().repos[0]?.repoFullName;
      if (repo) {
        const ghPR = github.getPR(repo, data.pullRequest.number);
        if (ghPR) data.pullRequest.state = ghPR.state.toLowerCase();
      }
    }

    if (args.json) { fmt.out(data); return; }
    log.info(`Task:    ${data.identifier} \u2014 ${data.title}\nStatus:  ${data.status}\nCreated: ${data.createdAt}`);
    if (data.pullRequest) {
      console.log(`PR:      ${data.pullRequest.url || `#${data.pullRequest.number}`} [${data.pullRequest.state}]`);
    }
    if (data.jams?.length) {
      log.step(`Jams (${data.jams.length})`);
      data.jams.forEach((j, i) => {
        console.log(`  ${i+1}. model=${j.model || "?"} status=${j.status || "?"} credits=${fmt.credits(j.credits)}`);
      });
    }
  },
});

export const start = defineCommand({
  meta: { name: "start", description: "Start a task" },
  args: {
    id: { type: "positional", description: "Task ID", required: true },
    ...modelArgs,
    ...jsonArg,
  },
  async run({ args }) {
    const api = await import("../api.js");
    const config = await import("../config.js");
    const fmt = await import("../output.js");

    const model = resolveModel(args) || config.load().defaultModel;
    const data = await api.startTask(args.id, model);
    if (args.json) { fmt.out(data); return; }
    console.log(`Started ${data.identifier || args.id} \u2192 ${data.status}`);
  },
});

export const stop = defineCommand({
  meta: { name: "stop", description: "Stop a task", alias: "kill" },
  args: {
    id: { type: "positional", description: "Task ID", required: true },
    reason: { type: "positional", required: false, description: "Stop reason" },
    ...jsonArg,
  },
  async run({ args }) {
    const api = await import("../api.js");
    const fmt = await import("../output.js");

    const data = await api.stopTask(args.id, args.reason);
    if (args.json) { fmt.out(data); return; }
    console.log(`Stopped ${data.identifier || args.id} \u2192 ${data.status}`);
  },
});

export const msg = defineCommand({
  meta: { name: "msg", description: "Message a task", alias: "message" },
  args: {
    id: { type: "positional", description: "Task ID", required: true },
    text: { type: "positional", description: "Message text", required: true },
    ...jsonArg,
  },
  async run({ args }) {
    const api = await import("../api.js");
    const fmt = await import("../output.js");

    await api.messageTask(args.id, args.text);
    if (args.json) { fmt.out({ id: args.id, message: args.text, status: "sent" }); return; }
    console.log("Message sent.");
  },
});
