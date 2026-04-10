import { defineCommand } from "citty";
import { jsonArg } from "./_shared.js";

export const init = defineCommand({
  meta: { name: "init", description: "Interactive setup wizard" },
  args: {},
  async run() {
    const p = await import("@clack/prompts");
    const config = await import("../config.js");
    const api = await import("../api.js");

    p.intro("capy setup");

    const cfg = config.load();

    // 1. API key
    const apiKey = await p.password({
      message: "Capy API key",
      mask: "*",
      validate: (v) => { if (!v) return "API key is required"; },
    });
    if (p.isCancel(apiKey)) { p.cancel("Setup cancelled."); process.exit(0); }

    // 2. Fetch projects + models in parallel using the key
    const s = p.spinner();
    s.start("Fetching your projects and models...");
    const [projects, models] = await Promise.all([
      api.listProjects(apiKey, cfg.server),
      api.listModelsWithKey(apiKey, cfg.server),
    ]);
    s.stop(`Found ${projects.length} project${projects.length !== 1 ? "s" : ""}, ${models.length} models`);

    if (!projects.length) {
      p.log.error("No projects found for this API key. Create one at capy.ai first.");
      process.exit(1);
    }

    // 3. Select project
    const projectId = projects.length === 1
      ? (() => { p.log.info(`Project: ${projects[0].name} (${projects[0].taskCode})`); return projects[0].id; })()
      : await (async () => {
          const sel = await p.select({
            message: "Select project",
            initialValue: cfg.projectId || projects[0].id,
            options: projects.map(proj => ({
              value: proj.id,
              label: proj.name,
              hint: `${proj.taskCode} \u2022 ${proj.repos.length} repo${proj.repos.length !== 1 ? "s" : ""}`,
            })),
          });
          if (p.isCancel(sel)) { p.cancel("Setup cancelled."); process.exit(0); }
          return sel;
        })();

    const selectedProject = projects.find(proj => proj.id === projectId)!;

    // 4. Show repos from project (auto-populated, no typing needed)
    if (selectedProject.repos.length) {
      p.log.info(`Repos:\n${selectedProject.repos.map(r => `  ${r.repoFullName} (${r.branch})`).join("\n")}`);
    } else {
      p.log.warn("No repos configured on this project. Add them at capy.ai.");
    }

    // 5. Select default model
    const captainModels = models.filter(m => m.captainEligible);
    const defaultModel = await p.select({
      message: "Default model",
      initialValue: cfg.defaultModel || "gpt-5.4",
      options: captainModels.map(m => ({
        value: m.id,
        label: m.name || m.id,
        hint: m.provider || undefined,
      })),
    });
    if (p.isCancel(defaultModel)) { p.cancel("Setup cancelled."); process.exit(0); }

    // 6. Review provider
    const reviewProvider = await p.select({
      message: "Review provider",
      initialValue: cfg.quality?.reviewProvider || "greptile",
      options: [
        { value: "greptile", label: "Greptile", hint: "AI code review via Greptile API" },
        { value: "capy", label: "Capy", hint: "GitHub unresolved review threads" },
        { value: "both", label: "Both", hint: "Strictest: Greptile + GitHub threads" },
        { value: "none", label: "None", hint: "Skip review gates" },
      ],
    });
    if (p.isCancel(reviewProvider)) { p.cancel("Setup cancelled."); process.exit(0); }

    // Save
    cfg.apiKey = apiKey;
    cfg.projectId = projectId as string;
    cfg.repos = selectedProject.repos;
    cfg.defaultModel = defaultModel as string;
    cfg.quality.reviewProvider = reviewProvider as string;

    config.save(cfg);
    p.outro(`Config saved to ${config.CONFIG_PATH}`);
  },
});

export const config = defineCommand({
  meta: { name: "config", description: "Get/set config" },
  args: {
    key: { type: "positional", required: false, description: "Config key (dot notation)" },
    value: { type: "positional", required: false, description: "Value to set" },
    ...jsonArg,
  },
  async run({ args }) {
    const configMod = await import("../config.js");
    const fmt = await import("../output.js");

    if (!args.key) {
      fmt.out(configMod.load());
      return;
    }
    if (!args.value) {
      const val = configMod.get(args.key);
      if (val === undefined) {
        if (args.json) { fmt.out({ error: { code: "unknown_key", message: `unknown config key "${args.key}"` } }); process.exit(1); }
        console.error(`capy: unknown config key "${args.key}"`);
        process.exit(1);
      }
      if (args.json || typeof val === "object") {
        fmt.out(args.json ? { [args.key]: val } : val);
      } else {
        console.log(String(val));
      }
      return;
    }
    configMod.set(args.key, args.value);
    console.log(`Set ${args.key} = ${configMod.get(args.key)}`);
  },
});

export const models = defineCommand({
  meta: { name: "models", description: "List available models" },
  args: { ...jsonArg },
  async run({ args }) {
    const api = await import("../api.js");
    const fmt = await import("../output.js");

    const data = await api.listModels();
    if (args.json) { fmt.out(data.models || []); return; }
    if (data.models) {
      fmt.table(["MODEL", "PROVIDER", "CAPTAIN"], data.models.map(m => [
        m.id, m.provider || "?", m.captainEligible ? "yes" : "no",
      ]));
    }
  },
});

export const tools = defineCommand({
  meta: { name: "tools", description: "All commands + env vars", alias: "commands" },
  args: { ...jsonArg },
  async run({ args }) {
    const configMod = await import("../config.js");
    const fmt = await import("../output.js");
    const { log } = await import("@clack/prompts");

    const all: Record<string, { args: string; desc: string }> = {
      captain:    { args: "<prompt>",              desc: "Start Captain thread" },
      build:      { args: "<prompt>",              desc: "Start Build agent (isolated)" },
      threads:    { args: "[list|get|msg|stop]",   desc: "Manage threads" },
      status:     { args: "",                      desc: "Dashboard" },
      list:       { args: "[status]",              desc: "List tasks" },
      get:        { args: "<id>",                  desc: "Task details" },
      start:      { args: "<id>",                  desc: "Start task" },
      stop:       { args: "<id> [reason]",         desc: "Stop task" },
      msg:        { args: "<id> <text>",           desc: "Message task" },
      diff:       { args: "<id>",                  desc: "View diff" },
      pr:         { args: "<id> [title]",          desc: "Create PR" },
      review:     { args: "<id>",                  desc: "Quality gates check" },
      "re-review":{ args: "<id>",                  desc: "Trigger Greptile re-review" },
      approve:    { args: "<id>",                  desc: "Approve if gates pass" },
      retry:      { args: "<id> [--fix=...]",      desc: "Retry with failure context" },
      wait:       { args: "<id>",                  desc: "Block until done" },
      watch:      { args: "<id>",                  desc: "Poll + notify on completion" },
      unwatch:    { args: "<id>",                  desc: "Stop watching" },
      watches:    { args: "",                      desc: "List watches" },
      models:     { args: "",                      desc: "List models" },
      tools:      { args: "",                      desc: "This list" },
      config:     { args: "[key] [value]",         desc: "Get/set config" },
      init:       { args: "",                      desc: "Interactive setup" },
    };

    if (args.json) { fmt.out(all); return; }

    const cfg = configMod.load();
    log.step("Available commands");
    for (const [name, t] of Object.entries(all)) {
      console.log(`  ${fmt.pad(name, 14)} ${fmt.pad(t.args, 24)} ${t.desc}`);
    }
    console.log(`\nConfig: ${configMod.CONFIG_PATH}`);
    console.log(`Review provider: ${cfg.quality?.reviewProvider || "greptile"}`);
    console.log(`Default model: ${cfg.defaultModel}`);
    console.log(`Repos: ${(cfg.repos || []).map(r => r.repoFullName).join(", ") || "none"}`);

    const envVars: [string, string][] = [
      ["CAPY_API_KEY", "API key (overrides config)"],
      ["CAPY_PROJECT_ID", "Project ID (overrides config)"],
      ["CAPY_SERVER", "API server URL"],
      ["CAPY_ENV_FILE", "Path to .env file"],
      ["GREPTILE_API_KEY", "Greptile API key"],
    ];
    log.step("Environment variables");
    envVars.forEach(([k, v]) => console.log(`  ${fmt.pad(k, 20)} ${v}`));
  },
});

export const status = defineCommand({
  meta: { name: "status", description: "Dashboard", alias: "dashboard" },
  args: { ...jsonArg },
  async run({ args }) {
    const api = await import("../api.js");
    const config = await import("../config.js");
    const github = await import("../github.js");
    const w = await import("../watch.js");
    const fmt = await import("../output.js");
    const { log, spinner } = await import("@clack/prompts");

    const cfg = config.load();

    let threads: Awaited<ReturnType<typeof api.listThreads>>, tasks: Awaited<ReturnType<typeof api.listTasks>>;
    if (!args.json) {
      const s = spinner();
      s.start("Loading dashboard...");
      [threads, tasks] = await Promise.all([api.listThreads({ limit: 10 }), api.listTasks({ limit: 30 })]);
      s.stop("Dashboard loaded");
    } else {
      [threads, tasks] = await Promise.all([api.listThreads({ limit: 10 }), api.listTasks({ limit: 30 })]);
    }

    if (args.json) {
      fmt.out({
        threads: threads.items || [],
        tasks: tasks.items || [],
        watches: w.list(),
      });
      return;
    }

    const active = (threads.items || []).filter(t => t.status === "active");
    if (active.length) {
      fmt.section("ACTIVE THREADS");
      active.forEach(t => console.log(`  ${t.id.slice(0, 14)}  ${(t.title || "(untitled)").slice(0, 50)}  [active]`));
    }

    const allTasks = tasks.items || [];
    const buckets: Record<string, typeof allTasks> = {};
    allTasks.forEach(t => { (buckets[t.status] = buckets[t.status] || []).push(t); });

    if (buckets.in_progress?.length) {
      fmt.section("IN PROGRESS");
      buckets.in_progress.forEach(t => {
        const j = (t.jams || []).at(-1);
        const stuck = j && j.status === "idle" && (!j.credits || (typeof j.credits === "object" && j.credits.llm === 0 && j.credits.vm === 0));
        console.log(`  ${fmt.pad(t.identifier, 10)} ${fmt.pad((t.title || "").slice(0, 48), 50)}${stuck ? " !! STUCK" : ""}`);
      });
    }

    if (buckets.needs_review?.length) {
      fmt.section("NEEDS REVIEW");
      buckets.needs_review.forEach(t => {
        let prInfo = "no PR";
        if (t.pullRequest?.number) {
          const repo = t.pullRequest.repoFullName || cfg.repos[0]?.repoFullName || "";
          const prData = github.getPR(repo, t.pullRequest.number);
          const state = prData ? prData.state : t.pullRequest.state || "?";
          const ci = github.getCIStatus(repo, t.pullRequest.number, prData);
          const ciStr = ci ? (ci.allGreen ? "CI pass" : ci.noChecks ? "no CI" : "CI FAIL") : "?";
          prInfo = `PR#${t.pullRequest.number} [${state}] ${ciStr}`;
        }
        console.log(`  ${fmt.pad(t.identifier, 10)} ${fmt.pad((t.title || "").slice(0, 42), 44)} ${prInfo}`);
      });
    }

    if (buckets.backlog?.length) {
      fmt.section(`BACKLOG (${buckets.backlog.length})`);
      buckets.backlog.forEach(t => console.log(`  ${fmt.pad(t.identifier, 10)} ${(t.title || "").slice(0, 60)}`));
    }

    const watchEntries = w.list();
    if (watchEntries.length) {
      fmt.section(`ACTIVE WATCHES (${watchEntries.length})`);
      watchEntries.forEach(e => console.log(`  ${fmt.pad(e.id.slice(0, 18), 20)} type=${e.type}  every ${e.intervalMin}min`));
    }

    const stuckCount = (buckets.in_progress || []).filter(t => {
      const j = (t.jams || []).at(-1);
      return j && j.status === "idle" && (!j.credits || (typeof j.credits === "object" && j.credits.llm === 0 && j.credits.vm === 0));
    }).length;

    log.info(`Summary: ${allTasks.length} tasks, ${(buckets.in_progress || []).length} active, ${(buckets.needs_review || []).length} review, ${stuckCount} stuck`);
  },
});
