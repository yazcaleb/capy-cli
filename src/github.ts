import { execFileSync } from "node:child_process";
import type { PRData, CIStatus, GreptileReview, DiffFile, StatusCheck } from "./types.js";

function gh(args: string[], opts: { timeout?: number } = {}): any | null {
  try {
    return JSON.parse(execFileSync("gh", args, {
      encoding: "utf8",
      timeout: opts.timeout || 15000,
      maxBuffer: 5 * 1024 * 1024,
    }));
  } catch {
    return null;
  }
}

export function getPR(repo: string, number: number): PRData | null {
  return gh(["pr", "view", String(number), "--repo", repo, "--json",
    "state,mergeable,mergedAt,closedAt,headRefName,baseRefName,title,body,url,number,additions,deletions,changedFiles,reviewDecision,statusCheckRollup,reviews,comments"]);
}

export function getPRReviewComments(repo: string, number: number): any[] {
  try {
    const out = execFileSync("gh", ["api", `repos/${repo}/pulls/${number}/comments`, "--paginate"], {
      encoding: "utf8", timeout: 15000, maxBuffer: 5 * 1024 * 1024,
    });
    return JSON.parse(out);
  } catch { return []; }
}

export function getPRIssueComments(repo: string, number: number): any[] {
  try {
    const out = execFileSync("gh", ["api", `repos/${repo}/issues/${number}/comments`, "--paginate"], {
      encoding: "utf8", timeout: 15000, maxBuffer: 5 * 1024 * 1024,
    });
    return JSON.parse(out);
  } catch { return []; }
}

export function getCIStatus(repo: string, number: number, prData?: PRData | null): CIStatus | null {
  const pr = prData || getPR(repo, number);
  if (!pr) return null;
  const checks: StatusCheck[] = pr.statusCheckRollup || [];
  const total = checks.length;
  const passing = checks.filter(c =>
    c.conclusion === "SUCCESS" || c.conclusion === "NEUTRAL"
  ).length;
  const failing = checks.filter(c =>
    c.conclusion === "FAILURE" || c.conclusion === "ERROR" || c.conclusion === "TIMED_OUT"
  );
  const pending = checks.filter(c =>
    c.status === "IN_PROGRESS" || c.status === "QUEUED" || c.status === "PENDING"
  );
  return {
    total,
    passing,
    failing: failing.map(c => ({ name: c.name || c.context || "", conclusion: c.conclusion })),
    pending: pending.map(c => ({ name: c.name || c.context || "", status: c.status })),
    allGreen: total > 0 && failing.length === 0 && pending.length === 0,
    noChecks: total === 0,
  };
}

export function parseGreptileReview(comments: any[]): GreptileReview | null {
  const greptile = comments.find((c: any) =>
    (c.user?.login || "").toLowerCase().includes("greptile") ||
    (c.body || "").includes("Confidence Score")
  );
  if (!greptile) return null;

  const body: string = greptile.body || "";
  const scoreMatch = body.match(/(?:Confidence\s*Score|confidence)[:\s]*(\d(?:\.\d)?)\s*\/\s*5/i);
  const score = scoreMatch ? parseFloat(scoreMatch[1]) : null;

  const logicCount = (body.match(/\bLogic\b/gi) || []).length;
  const syntaxCount = (body.match(/\bSyntax\b/gi) || []).length;
  const styleCount = (body.match(/\bStyle\b/gi) || []).length;

  return {
    score,
    issueCount: logicCount + syntaxCount + styleCount,
    logic: logicCount,
    syntax: syntaxCount,
    style: styleCount,
    body: body.slice(0, 2000),
    url: greptile.html_url,
  };
}

export function diffHasTests(files: DiffFile[]): boolean {
  if (!files) return false;
  return files.some(f => {
    const p = (f.path || f.filename || "").toLowerCase();
    return p.includes("test") || p.includes("spec") || p.includes("__tests__") ||
           p.endsWith(".test.ts") || p.endsWith(".test.js") || p.endsWith("_test.go") ||
           p.endsWith(".spec.ts") || p.endsWith(".spec.js");
  });
}

export function getUnresolvedThreads(repo: string, number: number): { body: string; author: string }[] {
  try {
    const query = `query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $number) { reviewThreads(first:100) { nodes { isResolved isOutdated comments(first:1) { nodes { body author { login } } } } } } } }`;
    const [owner, name] = repo.split("/");
    const out = execFileSync("gh", ["api", "graphql", "-f", `query=${query}`, "-F", `owner=${owner}`, "-F", `name=${name}`, "-F", `number=${number}`], {
      encoding: "utf8", timeout: 15000,
    });
    const data = JSON.parse(out);
    const threads = data?.data?.repository?.pullRequest?.reviewThreads?.nodes || [];
    return threads.filter((t: any) => !t.isResolved && !t.isOutdated).map((t: any) => ({
      body: t.comments?.nodes?.[0]?.body?.slice(0, 200) || "",
      author: t.comments?.nodes?.[0]?.author?.login || "unknown",
    }));
  } catch { return []; }
}
