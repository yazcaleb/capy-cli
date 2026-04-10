import { defineCommand } from "citty";
import { modelArgs, jsonArg, resolveModel } from "./_shared.js";

export const captain = defineCommand({
  meta: { name: "captain", description: "Start Captain thread", alias: "plan" },
  args: {
    prompt: { type: "positional", description: "Task prompt", required: false },
    resume: { type: "string", description: "Resume from a previous task ID (messages the existing thread)" },
    fix: { type: "string", description: "Specific fix instructions (used with --resume)" },
    ...modelArgs,
    ...jsonArg,
  },
  async run({ args }) {
    const api = await import("../api.js");
    const config = await import("../config.js");
    const { out, IS_JSON } = await import("../output.js");
    const { log } = await import("@clack/prompts");

    const cfg = config.load();
    const model = resolveModel(args) || cfg.defaultModel;

    if (args.resume) {
      const { resumeTask } = await import("../resume.js");
      const r = await resumeTask(args.resume, { prompt: args.prompt, fix: args.fix, model, mode: "captain" });

      if (IS_JSON) { out({ originalTask: r.originalTask, threadId: r.threadId, resumed: r.resumed, model }); return; }
      if (r.resumed) {
        log.success(`Messaged existing thread for ${r.originalTask}: https://capy.ai/project/${cfg.projectId}/captain/${r.threadId}`);
      } else {
        log.success(`Resumed ${r.originalTask} (new thread): https://capy.ai/project/${cfg.projectId}/captain/${r.threadId}`);
      }
      log.info(`Thread: ${r.threadId}  Model: ${model}`);
      return;
    }

    if (!args.prompt) {
      if (IS_JSON) { out({ error: { code: "missing_prompt", message: "Prompt is required (or use --resume <id>)" } }); process.exit(1); }
      console.error("capy: prompt is required (or use --resume <id>)");
      process.exit(1);
    }

    const data = await api.createThread(args.prompt, model);
    const url = `https://capy.ai/project/${cfg.projectId}/captain/${data.id}`;

    if (IS_JSON) { out({ ...data, url }); return; }
    log.success(`Captain started: ${url}`);
    log.info(`Thread: ${data.id}  Model: ${model}`);
  },
});

export const build = defineCommand({
  meta: { name: "build", description: "Start Build agent (isolated)", alias: "run" },
  args: {
    prompt: { type: "positional", description: "Task prompt", required: false },
    resume: { type: "string", description: "Resume from a previous task ID" },
    fix: { type: "string", description: "Specific fix instructions (used with --resume)" },
    ...modelArgs,
    ...jsonArg,
  },
  async run({ args }) {
    const api = await import("../api.js");
    const config = await import("../config.js");
    const { out, IS_JSON } = await import("../output.js");
    const { log } = await import("@clack/prompts");

    const cfg = config.load();
    const model = resolveModel(args) || cfg.defaultModel;

    if (args.resume) {
      const { resumeTask } = await import("../resume.js");
      const r = await resumeTask(args.resume, { prompt: args.prompt, fix: args.fix, model, mode: "build" });

      if (IS_JSON) { out({ originalTask: r.originalTask, newTask: r.threadId, model }); return; }
      log.success(`Resumed ${r.originalTask}: https://capy.ai/project/${cfg.projectId}/tasks/${r.threadId}`);
      log.info(`ID: ${r.threadId}  Model: ${model}`);
      return;
    }

    if (!args.prompt) {
      if (IS_JSON) { out({ error: { code: "missing_prompt", message: "Prompt is required (or use --resume <id>)" } }); process.exit(1); }
      console.error("capy: prompt is required (or use --resume <id>)");
      process.exit(1);
    }

    const data = await api.createTask(args.prompt, model);
    const url = `https://capy.ai/project/${cfg.projectId}/tasks/${data.id}`;

    if (IS_JSON) { out({ ...data, url }); return; }
    log.success(`Build started: ${url}`);
    log.info(`ID: ${data.identifier}  Model: ${model}`);
  },
});
