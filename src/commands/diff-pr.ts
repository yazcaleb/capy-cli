import { defineCommand } from "citty";
import { jsonArg } from "./_shared.js";

export const diff = defineCommand({
  meta: { name: "diff", description: "View task diff" },
  args: {
    id: { type: "positional", description: "Task ID", required: true },
    mode: { type: "string", description: "Diff mode", default: "run" },
    ...jsonArg,
  },
  async run({ args }) {
    const api = await import("../api.js");
    const fmt = await import("../output.js");

    const data = await api.getDiff(args.id, args.mode);
    if (args.json) { fmt.out(data); return; }
    console.log(`Diff (${data.source || "unknown"}): +${data.stats?.additions || 0} -${data.stats?.deletions || 0} in ${data.stats?.files || 0} files\n`);
    if (data.files) {
      data.files.forEach(f => {
        console.log(`--- ${f.path} (${f.state}) +${f.additions} -${f.deletions}`);
        if (f.patch) console.log(f.patch);
        console.log();
      });
    }
  },
});

export const pr = defineCommand({
  meta: { name: "pr", description: "Create a PR" },
  args: {
    id: { type: "positional", description: "Task ID", required: true },
    title: { type: "positional", required: false, description: "PR title" },
    description: { type: "string", description: "PR body/description" },
    draft: { type: "boolean", description: "Create as draft PR", default: false },
    ...jsonArg,
  },
  async run({ args }) {
    const api = await import("../api.js");
    const fmt = await import("../output.js");
    const { log } = await import("@clack/prompts");

    const body: Record<string, unknown> = {};
    if (args.title) body.title = args.title;
    if (args.description) body.description = args.description;
    if (args.draft) body.draft = true;
    const data = await api.createPR(args.id, body);
    if (args.json) { fmt.out(data); return; }
    log.success(`PR: ${data.url}`);
    log.info(`#${data.number} ${data.title} (${data.headRef} \u2192 ${data.baseRef})`);
  },
});
