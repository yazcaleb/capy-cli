import fs from "node:fs";
import path from "node:path";
import type { CapyConfig, QualityConfig } from "./types.js";

export const CONFIG_DIR = path.join(process.env.HOME || "/root", ".capy");
export const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");
export const WATCH_DIR = path.join(CONFIG_DIR, "watches");

const DEFAULTS: CapyConfig = {
  apiKey: "",
  projectId: "",
  server: "https://capy.ai/api/v1",
  repos: [],
  defaultModel: "gpt-5.4",
  quality: {
    requireCI: true,
    requireTests: true,
    reviewProvider: "greptile",
  },
  watchInterval: 3,
  notifyCommand: "",
};

export function load(): CapyConfig {
  const envPath = process.env.CAPY_ENV_FILE || path.join(CONFIG_DIR, ".env");
  try {
    fs.readFileSync(envPath, "utf8").split("\n").forEach(line => {
      const t = line.trim();
      if (!t || t.startsWith("#")) return;
      const eq = t.indexOf("=");
      if (eq === -1) return;
      const k = t.slice(0, eq).trim();
      const v = t.slice(eq + 1).trim();
      if (!process.env[k]) process.env[k] = v;
    });
  } catch {}

  let cfg: Partial<CapyConfig>;
  try {
    cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    cfg = {};
  }

  const merged: CapyConfig = { ...DEFAULTS, ...cfg } as CapyConfig;
  merged.quality = { ...DEFAULTS.quality, ...(cfg.quality || {}) } as QualityConfig;

  if (process.env.CAPY_API_KEY) merged.apiKey = process.env.CAPY_API_KEY;
  if (process.env.CAPY_PROJECT_ID) merged.projectId = process.env.CAPY_PROJECT_ID;
  if (process.env.CAPY_SERVER) merged.server = process.env.CAPY_SERVER;

  return merged;
}

export function save(cfg: CapyConfig): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
}

export function get(key: string): unknown {
  const cfg = load() as Record<string, unknown>;
  if (key.includes(".")) {
    const parts = key.split(".");
    let val: unknown = cfg;
    for (const p of parts) {
      val = (val as Record<string, unknown>)?.[p];
    }
    return val;
  }
  return cfg[key];
}

export function set(key: string, value: string): void {
  const cfg = load() as Record<string, unknown>;
  if (key.includes(".")) {
    const parts = key.split(".");
    let obj: Record<string, unknown> = cfg;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!obj[parts[i]]) obj[parts[i]] = {};
      obj = obj[parts[i]] as Record<string, unknown>;
    }
    let parsed: unknown = value;
    if (value === "true") parsed = true;
    else if (value === "false") parsed = false;
    else if (/^\d+$/.test(value)) parsed = parseInt(value);
    else if (/^\d+\.\d+$/.test(value)) parsed = parseFloat(value);
    obj[parts[parts.length - 1]] = parsed;
  } else {
    cfg[key] = value;
  }
  save(cfg as CapyConfig);
}
