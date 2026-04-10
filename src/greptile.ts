import * as config from "./config.js";
import { IS_JSON } from "./output.js";
import type { UnaddressedIssue } from "./types.js";

const MCP_URL = "https://api.greptile.com/mcp";

function warn(msg: string): void {
  if (!IS_JSON) console.error(msg);
}

async function mcp(method: string, params: Record<string, unknown>): Promise<any> {
  const cfg = config.load();
  const apiKey = cfg.greptileApiKey || process.env.GREPTILE_API_KEY || "";
  if (!apiKey) {
    warn("capy: GREPTILE_API_KEY not set. Run: capy config greptileApiKey <key>");
    return null;
  }

  const body = {
    jsonrpc: "2.0",
    id: Date.now(),
    method: "tools/call",
    params: {
      name: method,
      arguments: params,
    },
  };

  let res: Response;
  try {
    res = await fetch(MCP_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "Accept": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });
  } catch (e: unknown) {
    warn(`greptile: request failed — ${(e as Error).message}`);
    return null;
  }

  const text = await res.text();
  try {
    const data = JSON.parse(text);
    if (data.error) {
      warn(`greptile: ${data.error.message || JSON.stringify(data.error)}`);
      return null;
    }
    if (data.result?.content) {
      const textPart = data.result.content.find((c: any) => c.type === "text");
      if (textPart) {
        try { return JSON.parse(textPart.text); } catch { return textPart.text; }
      }
    }
    return data.result;
  } catch {
    warn(`greptile: bad response: ${text.slice(0, 300)}`);
    return null;
  }
}

export async function triggerReview(repo: string, prNumber: number, defaultBranch?: string): Promise<any> {
  return mcp("trigger_code_review", {
    name: repo,
    remote: "github",
    defaultBranch: defaultBranch || "main",
    prNumber,
  });
}

export async function listReviews(repo: string, prNumber: number): Promise<any> {
  return mcp("list_code_reviews", {
    name: repo,
    remote: "github",
    defaultBranch: "main",
    prNumber,
    limit: 5,
  });
}

export async function getReview(reviewId: string): Promise<any> {
  return mcp("get_code_review", { codeReviewId: reviewId });
}

export async function getPR(repo: string, prNumber: number, defaultBranch?: string): Promise<any> {
  return mcp("get_merge_request", {
    name: repo,
    remote: "github",
    defaultBranch: defaultBranch || "main",
    prNumber,
  });
}

export async function listComments(repo: string, prNumber: number, opts: { defaultBranch?: string; greptileOnly?: boolean; unaddressedOnly?: boolean } = {}): Promise<any> {
  const params: Record<string, unknown> = {
    name: repo,
    remote: "github",
    defaultBranch: opts.defaultBranch || "main",
    prNumber,
  };
  if (opts.greptileOnly) params.greptileGenerated = true;
  if (opts.unaddressedOnly) params.addressed = false;
  return mcp("list_merge_request_comments", params);
}

export async function waitForReview(reviewId: string, timeoutMs = 120000): Promise<any> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const review = await getReview(reviewId);
    if (!review) return null;
    if (review.status === "COMPLETED") return review;
    if (review.status === "FAILED") return review;
    await new Promise(r => setTimeout(r, 5000));
  }
  return null;
}

export async function freshReview(repo: string, prNumber: number, defaultBranch?: string): Promise<any> {
  const trigger = await triggerReview(repo, prNumber, defaultBranch);
  if (!trigger) return null;

  const reviewId = trigger.codeReviewId || trigger.id;
  if (!reviewId) return trigger;

  warn(`greptile: review triggered (${reviewId}), waiting...`);
  return waitForReview(reviewId);
}

export async function getUnaddressedIssues(repo: string, prNumber: number, defaultBranch?: string): Promise<UnaddressedIssue[]> {
  const comments = await listComments(repo, prNumber, {
    defaultBranch,
    greptileOnly: true,
    unaddressedOnly: true,
  });
  if (!comments || !Array.isArray(comments)) return [];
  return comments.map((c: any) => ({
    body: (c.body || "").slice(0, 200),
    file: c.path || c.file || "?",
    line: c.line || c.position || "?",
    hasSuggestion: !!c.hasSuggestion,
    suggestedCode: c.suggestedCode || null,
  }));
}

export async function needsReReview(repo: string, prNumber: number, defaultBranch?: string): Promise<{ hasNewCommits: boolean; reviewCompleteness: string } | null> {
  const pr = await getPR(repo, prNumber, defaultBranch);
  if (!pr) return null;
  return {
    hasNewCommits: !!pr.reviewAnalysis?.hasNewCommitsSinceReview,
    reviewCompleteness: pr.reviewAnalysis?.reviewCompleteness || "unknown",
  };
}
