import { defineCommand } from "citty";
import { jsonArg } from "./_shared.js";

interface TriageTask {
  identifier: string;
  title: string;
  status: string;
  labels: string[];
  category: "merged" | "ready" | "needs_pr" | "stuck" | "backlog" | "in_progress";
  pr?: { number: number; state: string; url?: string };
  diff?: { files: number; additions: number; deletions: number };
  jam?: { model: string; status: string; credits: { llm: number; vm: number } };
  createdAt?: string;
  updatedAt?: string;
}

interface TriageResult {
  summary: { total: number; merged: number; ready: number; needs_pr: number; stuck: number; backlog: number; in_progress: number };
  tasks: TriageTask[];
  recommendations: string[];
}

export const triage = defineCommand({
  meta: { name: "triage", description: "Actionable status for all tasks with diffs, PR state, and recommendations" },
  args: {
    ids: { type: "positional", required: false, description: "Specific task IDs (comma-separated or space-separated)" },
    ...jsonArg,
  },
  async run({ args }) {
    const api = await import("../api.js");
    const config = await import("../config.js");
    const github = await import("../github.js");
    const fmt = await import("../output.js");
    const { log, spinner } = await import("@clack/prompts");

    const cfg = config.load();

    // Get base task list
    let tasks: any[];
    if (args.ids) {
      const ids = args.ids.split(/[,\s]+/).filter(Boolean);
      tasks = await Promise.all(ids.map(id => api.getTask(id)));
    } else {
      const data = await api.listTasks({ limit: 100 });
      tasks = data.items || [];
    }

    if (!tasks.length) {
      if (args.json) { fmt.out({ summary: { total: 0 }, tasks: [], recommendations: [] }); return; }
      console.log("No tasks.");
      return;
    }

    // Fetch detail + diff in parallel for all tasks
    if (!args.json) {
      const s = spinner();
      s.start(`Loading ${tasks.length} tasks (details + diffs)...`);
      var results = await enrichTasks(api, tasks, cfg);
      s.stop(`${tasks.length} tasks loaded`);
    } else {
      var results = await enrichTasks(api, tasks, cfg);
    }

    // Cross-ref PR state with GitHub
    for (const r of results) {
      if (r.pr && r.pr.state === "closed") {
        const repo = r._raw?.pullRequest?.repoFullName || cfg.repos[0]?.repoFullName;
        if (repo) {
          const ghPR = github.getPR(repo, r.pr.number);
          if (ghPR) r.pr.state = ghPR.state.toLowerCase();
        }
      }
    }

    // Categorize
    const triaged: TriageTask[] = results.map(r => {
      let category: TriageTask["category"];
      if (r.status === "backlog") {
        category = "backlog";
      } else if (r.status === "in_progress") {
        category = "in_progress";
      } else if (r.pr?.state === "merged") {
        category = "merged";
      } else if (r.pr && r.pr.state === "open") {
        category = "ready";
      } else if (r.diff && r.diff.files > 0 && !r.pr) {
        category = "needs_pr";
      } else if (r.status === "needs_review" && (!r.diff || r.diff.files === 0)) {
        category = "stuck";
      } else if (r.status === "needs_review" && r.pr) {
        category = "ready";
      } else {
        category = "stuck";
      }

      return {
        identifier: r.identifier,
        title: r.title,
        status: r.status,
        labels: r.labels || [],
        category,
        ...(r.pr ? { pr: { number: r.pr.number, state: r.pr.state, url: r.pr.url } } : {}),
        ...(r.diff ? { diff: r.diff } : {}),
        ...(r.jam ? { jam: r.jam } : {}),
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      };
    });

    // Sort: in_progress first, then needs_pr, ready, stuck, backlog, merged
    const order: Record<string, number> = { in_progress: 0, needs_pr: 1, ready: 2, stuck: 3, backlog: 4, merged: 5 };
    triaged.sort((a, b) => (order[a.category] ?? 9) - (order[b.category] ?? 9));

    // Build summary
    const summary = {
      total: triaged.length,
      merged: triaged.filter(t => t.category === "merged").length,
      ready: triaged.filter(t => t.category === "ready").length,
      needs_pr: triaged.filter(t => t.category === "needs_pr").length,
      stuck: triaged.filter(t => t.category === "stuck").length,
      backlog: triaged.filter(t => t.category === "backlog").length,
      in_progress: triaged.filter(t => t.category === "in_progress").length,
    };

    // Build recommendations
    const recs: string[] = [];
    const needsPr = triaged.filter(t => t.category === "needs_pr");
    const stuck = triaged.filter(t => t.category === "stuck");
    const ready = triaged.filter(t => t.category === "ready");
    const inProgress = triaged.filter(t => t.category === "in_progress");

    if (needsPr.length) {
      recs.push(`Create PRs: ${needsPr.map(t => t.identifier).join(", ")} (have diffs, no PR)`);
    }
    if (ready.length) {
      recs.push(`Review + approve: ${ready.map(t => t.identifier).join(", ")}`);
    }
    if (stuck.length) {
      // Detect duplicates by similar titles
      const stuckTitles = stuck.map(t => t.title.replace(/^(Implement |PLW-\d+ (BLOCKER|MEDIUM|LOW): )/i, "").slice(0, 40));
      const dupes = stuck.filter((t, i) => {
        const norm = stuckTitles[i];
        return triaged.some(other =>
          other.identifier !== t.identifier &&
          (other.category === "needs_pr" || other.category === "ready" || other.category === "merged") &&
          other.title.replace(/^(Implement |PLW-\d+ (BLOCKER|MEDIUM|LOW): )/i, "").slice(0, 40) === norm
        );
      });
      if (dupes.length) {
        recs.push(`Stop duplicates: ${dupes.map(t => t.identifier).join(", ")} (no output, duplicates of working tasks)`);
      }
      const realStuck = stuck.filter(t => !dupes.includes(t));
      if (realStuck.length) {
        recs.push(`Retry or stop: ${realStuck.map(t => t.identifier).join(", ")} (no diff produced)`);
      }
    }

    const result: TriageResult = { summary, tasks: triaged, recommendations: recs };

    if (args.json) { fmt.out(result); return; }

    // Human output
    const groups: Record<string, TriageTask[]> = {};
    triaged.forEach(t => { (groups[t.category] = groups[t.category] || []).push(t); });

    const sectionNames: Record<string, string> = {
      in_progress: "IN PROGRESS",
      needs_pr: "HAS CODE, NEEDS PR",
      ready: "READY TO REVIEW",
      stuck: "STUCK (no output)",
      backlog: "BACKLOG",
      merged: "MERGED",
    };

    for (const cat of ["in_progress", "needs_pr", "ready", "stuck", "backlog", "merged"]) {
      const items = groups[cat];
      if (!items?.length) continue;

      fmt.section(`${sectionNames[cat]} (${items.length})`);
      items.forEach(t => {
        let line = `  ${fmt.pad(t.identifier, 8)}`;

        if (t.pr) {
          line += ` PR#${fmt.pad(String(t.pr.number), 4)} [${fmt.pad(t.pr.state, 6)}]`;
        } else {
          line += `              `;
        }

        if (t.diff && t.diff.files > 0) {
          line += ` +${fmt.pad(String(t.diff.additions), 5)} -${fmt.pad(String(t.diff.deletions), 5)} ${fmt.pad(t.diff.files + " files", 8)}`;
        } else {
          line += `                         `;
        }

        if (t.jam) {
          line += ` ${fmt.pad(t.jam.model, 12)}`;
        }

        line += `  ${(t.title || "").slice(0, 45)}`;
        console.log(line);
      });
    }

    console.log();
    log.info(`Summary: ${summary.total} tasks — ${summary.in_progress} active, ${summary.needs_pr} need PR, ${summary.ready} to review, ${summary.stuck} stuck, ${summary.merged} merged`);

    if (recs.length) {
      console.log();
      log.step("Recommendations");
      recs.forEach((r, i) => console.log(`  ${i + 1}. ${r}`));
    }
  },
});

async function enrichTasks(api: typeof import("../api.js"), tasks: any[], cfg: any) {
  // Fetch full details and diffs in parallel batches
  const enriched = await Promise.all(tasks.map(async (task) => {
    const id = task.identifier || task.id;
    let detail: any = task;
    let diff: any = null;

    try {
      // Only fetch detail if list response (no jams field)
      if (!task.jams) {
        detail = await api.getTask(id);
      }
    } catch {}

    try {
      diff = await api.getDiff(id);
    } catch {}

    const lastJam = (detail.jams || []).at(-1);
    const credits = lastJam?.credits;

    return {
      identifier: detail.identifier || id,
      title: detail.title || task.title || "",
      status: detail.status || task.status,
      labels: detail.labels || task.labels || [],
      createdAt: detail.createdAt || task.createdAt,
      updatedAt: detail.updatedAt || task.updatedAt,
      pr: detail.pullRequest?.number ? {
        number: detail.pullRequest.number,
        state: detail.pullRequest.state || "?",
        url: detail.pullRequest.url,
      } : null,
      diff: diff?.stats ? {
        files: diff.stats.files || 0,
        additions: diff.stats.additions || 0,
        deletions: diff.stats.deletions || 0,
      } : null,
      jam: lastJam ? {
        model: lastJam.model || "?",
        status: lastJam.status || "?",
        credits: {
          llm: typeof credits === "object" ? (credits?.llm ?? 0) : (credits || 0),
          vm: typeof credits === "object" ? (credits?.vm ?? 0) : 0,
        },
      } : null,
      _raw: detail,
    };
  }));

  return enriched;
}
