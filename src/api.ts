import * as config from "./config.js";
import type { Task, Thread, ThreadMessage, DiffData, Model, ListResponse, PullRequestRef } from "./types.js";

export class CapyError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "CapyError";
  }
}

function fail(code: string, message: string): never {
  throw new CapyError(code, message);
}

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const SAFE_METHODS = new Set(["GET", "HEAD"]);
const MAX_RETRIES = 3;

async function rawRequest(apiKey: string, server: string, method: string, path: string, body?: unknown): Promise<any> {
  const url = `${server}${path}`;
  const headers: Record<string, string> = {
    "Authorization": `Bearer ${apiKey}`,
    "Accept": "application/json",
  };
  if (body) {
    headers["Content-Type"] = "application/json";
  }

  const isSafe = SAFE_METHODS.has(method.toUpperCase());
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const base = Math.min(1000 * 2 ** (attempt - 1), 8000);
      const jitter = Math.random() * base * 0.5;
      await new Promise(r => setTimeout(r, base + jitter));
    }

    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers,
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch (e: unknown) {
      lastError = e as Error;
      if (isSafe && attempt < MAX_RETRIES) continue;
      fail("network_error", `request failed after ${attempt + 1} attempts — ${lastError.message}`);
    }

    const canRetryStatus = res.status === 429 || (isSafe && RETRYABLE_STATUS.has(res.status));
    if (canRetryStatus && attempt < MAX_RETRIES) {
      continue;
    }

    const text = await res.text();
    let data: any;
    try {
      data = JSON.parse(text);
    } catch {
      fail("bad_response", `bad API response: ${text.slice(0, 200)}`);
    }
    if (data.error) {
      fail(data.error.code || "api_error", data.error.message || "unknown API error");
    }
    return data;
  }

  fail("network_error", `request failed after ${MAX_RETRIES + 1} attempts — ${lastError?.message || "unknown"}`);
}

async function request(method: string, path: string, body?: unknown): Promise<any> {
  const cfg = config.load();
  if (!cfg.apiKey) {
    fail("no_api_key", "API key not configured. Run: capy init");
  }
  return rawRequest(cfg.apiKey, cfg.server, method, path, body);
}

// --- Init helpers (accept key directly, before config is saved) ---
export interface Project {
  id: string;
  name: string;
  description?: string | null;
  taskCode: string;
  repos: { repoFullName: string; branch: string }[];
}

export async function listProjects(apiKey: string, server = "https://capy.ai/api/v1"): Promise<Project[]> {
  const data = await rawRequest(apiKey, server, "GET", "/projects");
  return data.items || [];
}

export async function listModelsWithKey(apiKey: string, server = "https://capy.ai/api/v1"): Promise<Model[]> {
  const data = await rawRequest(apiKey, server, "GET", "/models");
  return data.models || [];
}

export async function listProjectsAuth(): Promise<Project[]> {
  const data = await request("GET", "/projects");
  return data.items || [];
}

export async function getProject(id?: string): Promise<Project & { createdAt?: string; updatedAt?: string }> {
  const pid = id || config.load().projectId;
  return request("GET", `/projects/${pid}`);
}

// --- Threads ---
export async function createThread(prompt: string, model?: string, opts: { repos?: unknown[]; attachmentUrls?: string[] } = {}): Promise<Thread> {
  const cfg = config.load();
  return request("POST", "/threads", {
    projectId: cfg.projectId,
    prompt,
    model: model || cfg.defaultModel,
    repos: opts.repos || cfg.repos,
    ...(opts.attachmentUrls?.length ? { attachmentUrls: opts.attachmentUrls } : {}),
  });
}

export async function listThreads(opts: { limit?: number; status?: string; cursor?: string; prNumber?: number; branch?: string } = {}): Promise<ListResponse<Thread>> {
  const cfg = config.load();
  const p = new URLSearchParams({ projectId: cfg.projectId, limit: String(opts.limit || 10) });
  if (opts.status) p.set("status", opts.status);
  if (opts.cursor) p.set("cursor", opts.cursor);
  if (opts.prNumber) p.set("prNumber", String(opts.prNumber));
  if (opts.branch) p.set("branch", opts.branch);
  return request("GET", `/threads?${p}`);
}

export async function getThread(id: string): Promise<Thread> {
  return request("GET", `/threads/${id}`);
}

export async function messageThread(id: string, msg: string, opts: { model?: string; attachmentUrls?: string[] } = {}): Promise<unknown> {
  return request("POST", `/threads/${id}/message`, {
    message: msg,
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.attachmentUrls?.length ? { attachmentUrls: opts.attachmentUrls } : {}),
  });
}

export async function stopThread(id: string): Promise<unknown> {
  return request("POST", `/threads/${id}/stop`);
}

export async function getThreadMessages(id: string, opts: { limit?: number } = {}): Promise<ListResponse<ThreadMessage>> {
  const p = new URLSearchParams({ limit: String(opts.limit || 50) });
  return request("GET", `/threads/${id}/messages?${p}`);
}

// --- Tasks ---
export async function createTask(prompt: string, model?: string, opts: { title?: string; start?: boolean; labels?: string[]; attachmentUrls?: string[] } = {}): Promise<Task> {
  const cfg = config.load();
  return request("POST", "/tasks", {
    projectId: cfg.projectId,
    prompt,
    title: (opts.title || prompt).slice(0, 80),
    repos: cfg.repos,
    model: model || cfg.defaultModel,
    start: opts.start !== false,
    ...(opts.labels ? { labels: opts.labels } : {}),
    ...(opts.attachmentUrls?.length ? { attachmentUrls: opts.attachmentUrls } : {}),
  });
}

export async function listTasks(opts: { limit?: number; status?: string; cursor?: string; prNumber?: number; branch?: string } = {}): Promise<ListResponse<Task>> {
  const cfg = config.load();
  const p = new URLSearchParams({ projectId: cfg.projectId, limit: String(opts.limit || 30) });
  if (opts.status) p.set("status", opts.status);
  if (opts.cursor) p.set("cursor", opts.cursor);
  if (opts.prNumber) p.set("prNumber", String(opts.prNumber));
  if (opts.branch) p.set("branch", opts.branch);
  return request("GET", `/tasks?${p}`);
}

export async function getTask(id: string): Promise<Task> {
  return request("GET", `/tasks/${id}`);
}

export async function startTask(id: string, model?: string): Promise<Task> {
  return request("POST", `/tasks/${id}/start`, { model: model || config.load().defaultModel });
}

export async function stopTask(id: string, reason?: string): Promise<Task> {
  return request("POST", `/tasks/${id}/stop`, reason ? { reason } : {});
}

export async function messageTask(id: string, msg: string, opts: { attachmentUrls?: string[] } = {}): Promise<unknown> {
  return request("POST", `/tasks/${id}/message`, {
    message: msg,
    ...(opts.attachmentUrls?.length ? { attachmentUrls: opts.attachmentUrls } : {}),
  });
}

export async function createPR(id: string, opts: Record<string, unknown> = {}): Promise<PullRequestRef & { url?: string; number?: number; title?: string; headRef?: string; baseRef?: string }> {
  return request("POST", `/tasks/${id}/pr`, opts);
}

export async function getDiff(id: string, mode = "run"): Promise<DiffData> {
  return request("GET", `/tasks/${id}/diff?mode=${mode}`);
}

export async function listModels(): Promise<{ models?: Model[] }> {
  return request("GET", "/models");
}

// --- Warm Pool ---
export interface WarmPoolConfig {
  enabled: boolean;
  targetSize: number;
  maxAgeMinutes: number;
  branch?: string;
  setupCommands?: string[];
  instances?: WarmPoolInstance[];
}

export interface WarmPoolInstance {
  id: string;
  status: string;
  createdAt?: string;
  claimedAt?: string;
  logs?: string;
}

export async function getWarmPool(projectId?: string): Promise<WarmPoolConfig> {
  const pid = projectId || config.load().projectId;
  return request("GET", `/projects/${pid}/warm-pool`);
}

export async function updateWarmPool(update: { enabled?: boolean; targetSize?: number; maxAgeMinutes?: number; branch?: string; setupCommands?: string[] }, projectId?: string): Promise<WarmPoolConfig> {
  const pid = projectId || config.load().projectId;
  return request("PATCH", `/projects/${pid}/warm-pool`, update);
}

export async function testWarmPool(projectId?: string): Promise<{ instanceId: string; status: string }> {
  const pid = projectId || config.load().projectId;
  return request("POST", `/projects/${pid}/warm-pool/test`);
}

export async function listWarmPoolInstances(opts: { status?: string } = {}, projectId?: string): Promise<WarmPoolInstance[]> {
  const pid = projectId || config.load().projectId;
  const p = new URLSearchParams();
  if (opts.status) p.set("status", opts.status);
  const qs = p.toString();
  const data = await request("GET", `/projects/${pid}/warm-pool/instances${qs ? `?${qs}` : ""}`);
  return Array.isArray(data) ? data : data.instances || data.items || [];
}

export async function getWarmPoolInstance(instanceId: string, projectId?: string): Promise<WarmPoolInstance> {
  const pid = projectId || config.load().projectId;
  return request("GET", `/projects/${pid}/warm-pool/instances/${instanceId}`);
}

export async function clearWarmPool(opts: { replenish?: boolean } = {}, projectId?: string): Promise<unknown> {
  const pid = projectId || config.load().projectId;
  return request("POST", `/projects/${pid}/warm-pool/clear`, opts.replenish != null ? { replenish: opts.replenish } : {});
}
