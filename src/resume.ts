export interface ResumeResult {
  threadId: string;
  originalTask: string;
  resumed: boolean;
}

export async function resumeTask(taskId: string, opts: {
  prompt?: string;
  fix?: string;
  model?: string;
  mode: "captain" | "build";
}): Promise<ResumeResult> {
  const api = await import("./api.js");
  const config = await import("./config.js");

  const task = await api.getTask(taskId);
  const cfg = config.load();
  const model = opts.model || cfg.defaultModel;

  if (task.status === "in_progress") {
    await api.stopTask(taskId, "Resuming with fixes");
  }

  // Find parent Captain thread by searching recent threads for this task
  if (opts.mode === "captain") {
    const parentThreadId = await findParentThread(api, taskId, task.id);
    if (parentThreadId) {
      const message = buildMessage(task, opts.prompt, opts.fix);
      await api.messageThread(parentThreadId, message, { model });
      return { threadId: parentThreadId, originalTask: task.identifier, resumed: true };
    }
  }

  // Fallback: no parent thread found (standalone build task, or old task)
  const context = await gatherContext(taskId, task, cfg);
  const fullPrompt = buildNewPrompt(task, context, opts.prompt, opts.fix);

  if (opts.mode === "build") {
    const data = await api.createTask(fullPrompt, model);
    return { threadId: data.id, originalTask: task.identifier, resumed: false };
  }

  const data = await api.createThread(fullPrompt, model);
  return { threadId: data.id, originalTask: task.identifier, resumed: false };
}

async function findParentThread(api: typeof import("./api.js"), taskIdentifier: string, taskUuid: string): Promise<string | null> {
  try {
    const threads = await api.listThreads({ limit: 50 });
    for (const thread of threads.items || []) {
      if (thread.tasks?.some(t => t.identifier === taskIdentifier || t.id === taskUuid)) {
        return thread.id;
      }
    }
  } catch {}
  return null;
}

function buildMessage(task: any, prompt?: string, fix?: string): string {
  let msg = "";
  if (fix) msg += fix;
  if (prompt && prompt !== (task.prompt || task.title)) {
    msg += (msg ? "\n\n" : "") + prompt;
  }
  if (!msg) msg = "Fix the issues from the previous attempt. Include tests. Run tests before completing.";
  return msg;
}

async function gatherContext(taskId: string, task: any, cfg: any): Promise<string> {
  const api = await import("./api.js");
  const github = await import("./github.js");
  const greptileApi = await import("./greptile.js");

  let context = `Previous attempt: ${task.identifier} "${task.title}" [${task.status}]\n`;

  try {
    const d = await api.getDiff(taskId);
    if (d.stats?.files && d.stats.files > 0) {
      context += `\nPrevious diff: +${d.stats.additions} -${d.stats.deletions} in ${d.stats.files} files\n`;
      context += `Files changed: ${(d.files || []).map((f: any) => f.path).join(", ")}\n`;
    } else {
      context += `\nPrevious diff: empty (agent produced no changes)\n`;
    }
  } catch { context += "\nPrevious diff: unavailable\n"; }

  if (task.pullRequest?.number) {
    const repo = task.pullRequest.repoFullName || cfg.repos[0]?.repoFullName || "";
    const prNum = task.pullRequest.number;
    const defaultBranch = cfg.repos.find((r: any) => r.repoFullName === repo)?.branch || "main";
    const reviewComments = github.getPRReviewComments(repo, prNum);
    const ci = github.getCIStatus(repo, prNum);

    const reviewProvider = cfg.quality?.reviewProvider || "greptile";
    const hasGreptileKey = !!(cfg.greptileApiKey || process.env.GREPTILE_API_KEY);

    if ((reviewProvider === "greptile" || reviewProvider === "both") && hasGreptileKey) {
      const unaddressed = await greptileApi.getUnaddressedIssues(repo, prNum, defaultBranch);
      if (unaddressed.length > 0) {
        context += `\nUnaddressed Greptile issues (${unaddressed.length}):\n`;
        unaddressed.forEach((u: any) => {
          context += `  ${u.file}:${u.line}: ${u.body}\n`;
          if (u.suggestedCode) context += `    Suggested fix: ${u.suggestedCode.slice(0, 200)}\n`;
        });
      } else {
        context += `\nGreptile: all issues addressed\n`;
      }
    } else {
      const issueComments = github.getPRIssueComments(repo, prNum);
      const greptileReview = github.parseGreptileReview(issueComments);
      if (greptileReview) {
        context += `\nGreptile review: ${greptileReview.score}/5 (stale, may not reflect latest)\n`;
      }
    }

    if (ci && !ci.allGreen) {
      context += `\nCI failures: ${ci.failing.map((f: any) => f.name).join(", ")}\n`;
    }
    if (reviewComments.length) {
      context += `\nReview comments (${reviewComments.length}):\n`;
      reviewComments.slice(0, 5).forEach((c: any) => {
        context += `  ${c.path}:${c.line || "?"}: ${(c.body || "").slice(0, 150)}\n`;
      });
    }
  }

  return context;
}

function buildNewPrompt(task: any, context: string, prompt?: string, fix?: string): string {
  let p = `RESUME: Continuing from a previous attempt.\n\n`;
  p += `Original task: ${task.prompt || task.title}\n\n`;
  p += `--- CONTEXT FROM PREVIOUS ATTEMPT ---\n${context}\n`;
  if (fix) p += `--- SPECIFIC FIX REQUESTED ---\n${fix}\n\n`;
  if (prompt && prompt !== (task.prompt || task.title)) p += `--- UPDATED INSTRUCTIONS ---\n${prompt}\n\n`;
  p += `--- INSTRUCTIONS ---\n`;
  p += `Fix the issues from the previous attempt. Do not repeat the same mistakes.\n`;
  p += `Include tests. Run tests before completing. Verify CI will pass.\n`;
  return p;
}
