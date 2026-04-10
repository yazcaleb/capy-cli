import { defineCommand } from "citty";
import { jsonArg } from "./_shared.js";

const list = defineCommand({
  meta: { name: "list", description: "List threads" },
  args: { ...jsonArg },
  async run({ args }) {
    const api = await import("../api.js");
    const fmt = await import("../output.js");

    const data = await api.listThreads();
    if (args.json) { fmt.out(data.items || []); return; }
    if (!data.items?.length) { console.log("No threads."); return; }
    fmt.table(["ID", "STATUS", "TITLE"], data.items.map(t => [
      t.id.slice(0, 16), t.status, (t.title || "(untitled)").slice(0, 40),
    ]));
  },
});

const get = defineCommand({
  meta: { name: "get", description: "Get thread details" },
  args: {
    id: { type: "positional", description: "Thread ID", required: true },
    ...jsonArg,
  },
  async run({ args }) {
    const api = await import("../api.js");
    const fmt = await import("../output.js");
    const { log } = await import("@clack/prompts");

    const data = await api.getThread(args.id);
    if (args.json) { fmt.out(data); return; }
    log.info(`Thread: ${data.id}\nTitle:  ${data.title || "(untitled)"}\nStatus: ${data.status}`);
    if (data.tasks?.length) {
      log.step(`Tasks (${data.tasks.length})`);
      data.tasks.forEach(t => console.log(`  ${t.identifier} ${t.title} [${t.status}]`));
    }
    if (data.pullRequests?.length) {
      log.step("PRs");
      data.pullRequests.forEach(p => console.log(`  PR#${p.number} ${p.url} [${p.state}]`));
    }
  },
});

const msg = defineCommand({
  meta: { name: "msg", description: "Message a thread", alias: "message" },
  args: {
    id: { type: "positional", description: "Thread ID", required: true },
    text: { type: "positional", description: "Message text", required: true },
    ...jsonArg,
  },
  async run({ args }) {
    const api = await import("../api.js");
    const fmt = await import("../output.js");
    const result = await api.messageThread(args.id, args.text);
    if (args.json) { fmt.out(result); return; }
    console.log("Message sent.");
  },
});

const stop = defineCommand({
  meta: { name: "stop", description: "Stop a thread" },
  args: {
    id: { type: "positional", description: "Thread ID", required: true },
    ...jsonArg,
  },
  async run({ args }) {
    const api = await import("../api.js");
    const fmt = await import("../output.js");
    const result = await api.stopThread(args.id);
    if (args.json) { fmt.out(result); return; }
    console.log(`Stopped thread ${args.id}.`);
  },
});

const messages = defineCommand({
  meta: { name: "messages", description: "View thread messages", alias: "msgs" },
  args: {
    id: { type: "positional", description: "Thread ID", required: true },
    ...jsonArg,
  },
  async run({ args }) {
    const api = await import("../api.js");
    const fmt = await import("../output.js");

    const data = await api.getThreadMessages(args.id);
    if (args.json) { fmt.out(data.items || []); return; }
    (data.items || []).forEach(m => {
      console.log(`[${m.source}] ${m.content.slice(0, 200)}`);
      console.log();
    });
  },
});

export default defineCommand({
  meta: { name: "threads", description: "Manage Captain threads" },
  default: "list",
  subCommands: { list, get, msg, stop, messages },
});
