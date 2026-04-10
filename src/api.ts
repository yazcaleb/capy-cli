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

async function rawRequest(apiKey: string, server: string, method: string, path: string, body?: unknown): Promise<any> {
  const url = `${server}${path}`;
  const headers: Record<string, string> = {
    "Authorization": `Bearer ${apiKey}`,
    "Accept": "application/json",
  };
  const init: RequestInit = { method, headers };
  if (body) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }

  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (e: unknown) {
    fail("network_error", `request failed — ${(e as Error).message}`);
  }

  const text = await res.text();
  try {
    const data = JSON.parse(text);
    if (data.error) {
      fail("api_error", `API error — ${data.error.message || data.error.code}`);
    }
    return data;
  } catch {
    fail("bad_response", `bad API response: ${text.slice(0, 200)}`);
  }
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

// --- Threads ---
export async function createThread(prompt: string, model?: string, repos?: unknown[]): Promise<Thread> {
  const cfg = config.load();
  return request("POST", "/threads", {
    projectId: cfg.projectId,
    prompt,
    model: model || cfg.defaultModel,
    repos: repos || cfg.repos,
  });
}

export async function listThreads(opts: { limit?: number; status?: string } = {}): Promise<ListResponse<Thread>> {
  const cfg = config.load();
  const p = new URLSearchParams({ projectId: cfg.projectId, limit: String(opts.limit || 10) });
  if (opts.status) p.set("status", opts.status);
  return request("GET", `/threads?${p}`);
}

export async function getThread(id: string): Promise<Thread> {
  return request("GET", `/threads/${id}`);
}

export async function messageThread(id: string, msg: string): Promise<unknown> {
  return request("POST", `/threads/${id}/message`, { message: msg });
}

export async function stopThread(id: string): Promise<unknown> {
  return request("POST", `/threads/${id}/stop`);
}

export async function getThreadMessages(id: string, opts: { limit?: number } = {}): Promise<ListResponse<ThreadMessage>> {
  const p = new URLSearchParams({ limit: String(opts.limit || 50) });
  return request("GET", `/threads/${id}/messages?${p}`);
}

// --- Tasks ---
export async function createTask(prompt: string, model?: string, opts: { title?: string; start?: boolean; labels?: string[] } = {}): Promise<Task> {
  const cfg = config.load();
  return request("POST", "/tasks", {
    projectId: cfg.projectId,
    prompt,
    title: (opts.title || prompt).slice(0, 80),
    repos: cfg.repos,
    model: model || cfg.defaultModel,
    start: opts.start !== false,
    ...(opts.labels ? { labels: opts.labels } : {}),
  });
}

export async function listTasks(opts: { limit?: number; status?: string } = {}): Promise<ListResponse<Task>> {
  const cfg = config.load();
  const p = new URLSearchParams({ projectId: cfg.projectId, limit: String(opts.limit || 30) });
  if (opts.status) p.set("status", opts.status);
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

export async function messageTask(id: string, msg: string): Promise<unknown> {
  return request("POST", `/tasks/${id}/message`, { message: msg });
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
