import { defineCommand } from "citty";
import { modelArgs, jsonArg, resolveModel } from "./_shared.js";

export const review = defineCommand({
  meta: { name: "review", description: "Quality gates check" },
  args: {
    id: { type: "positional", description: "Task ID", required: true },
    ...jsonArg,
  },
  async run({ args }) {
    const api = await import("../api.js");
    const config = await import("../config.js");
    const github = await import("../github.js");
    const quality = await import("../quality-engine.js");
    const greptileApi = await import("../greptile.js");
    const fmt = await import("../output.js");
    const { log } = await import("@clack/prompts");

    const task = await api.getTask(args.id);
    const cfg = config.load();
    const reviewProvider = cfg.quality?.reviewProvider || "greptile";

    if (!task.pullRequest?.number) {
      if (args.json) { fmt.out({ error: { code: "no_pr", message: `${task.identifier}: No PR` }, task: task.identifier }); return; }
      log.warn(`${task.identifier}: No PR. Create one first: capy pr ${task.identifier}`);
      return;
    }

    const repo = task.pullRequest.repoFullName || cfg.repos[0]?.repoFullName || "";
    const prNum = task.pullRequest.number;
    const defaultBranch = cfg.repos.find(r => r.repoFullName === repo)?.branch || "main";

    let diffStats = null;
    try {
      const d = await api.getDiff(args.id);
      diffStats = d.stats || null;
    } catch {}

    const q = await quality.check(task);

    let unaddressed: Awaited<ReturnType<typeof greptileApi.getUnaddressedIssues>> = [];
    const hasGreptileKey = !!(cfg.greptileApiKey || process.env.GREPTILE_API_KEY);

    if ((reviewProvider === "greptile" || reviewProvider === "both") && hasGreptileKey) {
      unaddressed = await greptileApi.getUnaddressedIssues(repo, prNum, defaultBranch);
    }

    if (args.json) {
      fmt.out({
        task: task.identifier,
        quality: q,
        unaddressed,
        reviewProvider,
        diff: diffStats ? { files: diffStats.files || 0, additions: diffStats.additions || 0, deletions: diffStats.deletions || 0 } : null,
      });
      return;
    }

    const prOpen = q.gates.find(g => g.name === "pr_open");
    log.info(`Review: ${task.identifier} \u2014 ${task.title}`);
    console.log(`PR: #${prNum} [${prOpen?.detail || task.pullRequest?.state || "?"}]`);
    if (diffStats) console.log(`Diff: +${diffStats.additions || 0} -${diffStats.deletions || 0} in ${diffStats.files || 0} files`);
    console.log(`Review: ${reviewProvider}\n`);

    q.gates.forEach(g => {
      const icon = g.pass ? "\u2713" : "\u2717";
      console.log(`  ${icon} ${g.name}: ${g.detail}`);
      if (g.name === "ci" && g.failing?.length) {
        g.failing.forEach(f => console.log(`      \u2717 ${f.name} (${f.conclusion || f.status})`));
      }
      if (g.name === "ci" && g.pending?.length) {
        g.pending.forEach(f => console.log(`      ... ${f.name} (${f.status})`));
      }
    });

    if (unaddressed.length > 0) {
      log.warn(`Unaddressed Greptile issues (${unaddressed.length}):`);
      unaddressed.forEach(u => {
        console.log(`  ${u.file}:${u.line} ${u.body}`);
        if (u.hasSuggestion) console.log(`    ^ has suggested fix`);
      });
    }

    if (q.pass) {
      log.success(q.summary);
    } else {
      log.warn(q.summary);
    }

    const greptileGate = q.gates.find(g => g.name === "greptile");
    if (greptileGate && !greptileGate.pass) {
      if (greptileGate.detail.includes("processing")) {
        log.info(`Greptile is still processing. Wait a minute, then: capy review ${task.identifier}`);
      } else {
        log.info(`Fix the unaddressed issues, push, and Greptile will auto-re-review.\nThen: capy review ${task.identifier}`);
      }
    }
  },
});

export const reReview = defineCommand({
  meta: { name: "re-review", description: "Trigger Greptile re-review", alias: "rereview" },
  args: {
    id: { type: "positional", description: "Task ID", required: true },
    ...jsonArg,
  },
  async run({ args }) {
    const api = await import("../api.js");
    const config = await import("../config.js");
    const greptileApi = await import("../greptile.js");
    const fmt = await import("../output.js");
    const { log } = await import("@clack/prompts");

    const cfg = config.load();
    const reviewProvider = cfg.quality?.reviewProvider || "greptile";

    if (reviewProvider !== "greptile" && reviewProvider !== "both") {
      if (args.json) { fmt.out({ error: { code: "wrong_provider", message: `re-review requires Greptile provider (current: ${reviewProvider})` } }); process.exit(1); }
      console.error(`capy: re-review requires Greptile provider (current: ${reviewProvider})`);
      process.exit(1);
    }

    if (!cfg.greptileApiKey && !process.env.GREPTILE_API_KEY) {
      if (args.json) { fmt.out({ error: { code: "no_greptile_key", message: "GREPTILE_API_KEY not set" } }); process.exit(1); }
      console.error("capy: GREPTILE_API_KEY not set. Run: capy config greptileApiKey <key>");
      process.exit(1);
    }

    const task = await api.getTask(args.id);
    if (!task.pullRequest?.number) {
      if (args.json) { fmt.out({ error: { code: "no_pr", message: `${task.identifier}: No PR` } }); process.exit(1); }
      console.error(`${task.identifier}: No PR. Create one first: capy pr ${task.identifier}`);
      process.exit(1);
    }

    const repo = task.pullRequest.repoFullName || cfg.repos[0]?.repoFullName || "";
    const prNum = task.pullRequest.number;
    const defaultBranch = cfg.repos.find(r => r.repoFullName === repo)?.branch || "main";

    log.info(`Triggering fresh Greptile review for PR#${prNum}...`);
    console.log("(Note: Greptile auto-reviews on every push via triggerOnUpdates. This is a manual override.)");
    const result = await greptileApi.freshReview(repo, prNum, defaultBranch);

    if (args.json) { fmt.out(result); return; }

    if (result) {
      if (result.status === "COMPLETED") log.success("Review completed.");
      else if (result.status === "FAILED") log.error("Review failed. Check the PR state.");
      else log.info(`Review status: ${result.status || "unknown"}`);
    } else {
      log.info("Review triggered. Check back shortly or run: capy review " + task.identifier);
    }

    const unaddressed = await greptileApi.getUnaddressedIssues(repo, prNum, defaultBranch);
    if (unaddressed.length > 0) {
      log.warn(`Unaddressed issues: ${unaddressed.length}`);
      unaddressed.forEach(u => console.log(`  ${u.file}:${u.line} ${u.body}`));
    } else {
      log.success("All issues addressed.");
    }
  },
});

export const approve = defineCommand({
  meta: { name: "approve", description: "Approve if gates pass" },
  args: {
    id: { type: "positional", description: "Task ID", required: true },
    force: { type: "boolean", description: "Override failing gates", default: false },
    ...jsonArg,
  },
  async run({ args }) {
    const api = await import("../api.js");
    const config = await import("../config.js");
    const quality = await import("../quality-engine.js");
    const fmt = await import("../output.js");
    const { log } = await import("@clack/prompts");

    const task = await api.getTask(args.id);
    const cfg = config.load();
    const q = await quality.check(task);

    const approved = q.pass || !!args.force;

    if (args.json) {
      if (!approved) {
        fmt.out({ task: task.identifier, quality: q, approved: false, error: { code: "gates_failed", message: q.summary } });
        process.exit(1);
      }
      fmt.out({ task: task.identifier, quality: q, approved: true });
      return;
    }

    log.info(`${task.identifier} \u2014 ${task.title}\n`);
    q.gates.forEach(g => {
      const icon = g.pass ? "\u2713" : "\u2717";
      console.log(`  ${icon} ${g.name}: ${g.detail}`);
    });

    if (q.pass) log.success(q.summary);
    else log.warn(q.summary);

    if (!approved) {
      log.error("Blocked. Fix the failing gates or use --force to override.");
      process.exit(1);
    }

    if (q.pass || args.force) {
      log.success(`Approved.${args.force && !q.pass ? " (forced)" : ""}`);
      const approveCmd = cfg.approveCommand;
      if (approveCmd) {
        try {
          const { execSync } = await import("node:child_process");
          const { shellEscape } = await import("./_shared.js");
          const expanded = approveCmd
            .replace("{task}", shellEscape(task.identifier || task.id))
            .replace("{title}", shellEscape(task.title || ""))
            .replace("{pr}", shellEscape(String(task.pullRequest?.number || "")));
          execSync(expanded, { timeout: 15000, stdio: "pipe" });
          log.info("Post-approve hook ran.");
        } catch {}
      }
    }
  },
});

export const retry = defineCommand({
  meta: { name: "retry", description: "Alias for: capy captain --resume <id> --fix='...'" },
  args: {
    id: { type: "positional", description: "Task ID", required: true },
    fix: { type: "string", description: "Specific fix instructions" },
    ...modelArgs,
    ...jsonArg,
  },
  async run({ args }) {
    const config = await import("../config.js");
    const { resumeTask } = await import("../resume.js");
    const fmt = await import("../output.js");
    const { log } = await import("@clack/prompts");

    const cfg = config.load();
    const model = resolveModel(args) || cfg.defaultModel;
    const r = await resumeTask(args.id, { fix: args.fix, model, mode: "captain" });

    if (args.json) {
      fmt.out({ originalTask: r.originalTask, threadId: r.threadId, resumed: r.resumed, model });
      return;
    }

    if (r.resumed) {
      log.success(`Messaged existing thread for ${r.originalTask}: https://capy.ai/project/${cfg.projectId}/captain/${r.threadId}`);
    } else {
      log.success(`Retry started (new thread): https://capy.ai/project/${cfg.projectId}/captain/${r.threadId}`);
    }
    log.info(`Thread: ${r.threadId}  Model: ${model}`);
  },
});
