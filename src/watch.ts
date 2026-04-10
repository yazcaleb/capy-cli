import fs from "node:fs";
import path from "node:path";
import { execSync, execFileSync } from "node:child_process";
import * as config from "./config.js";
import { shellEscape } from "./commands/_shared.js";
import type { WatchEntry } from "./types.js";

function getCrontab(): string {
  try { return execSync("crontab -l 2>/dev/null", { encoding: "utf8" }); } catch { return ""; }
}

function setCrontab(content: string): void {
  execSync("crontab -", { input: content, encoding: "utf8" });
}

export function add(id: string, type: string, intervalMin: number): boolean {
  const watchDir = config.WATCH_DIR;
  fs.mkdirSync(watchDir, { recursive: true });

  const thisDir = path.dirname(new URL(import.meta.url).pathname);
  const binPath = path.resolve(thisDir, "..", "bin", "capy.ts");
  const runtime = process.execPath;
  const tag = `# capy-watch:${id}`;
  const cronLine = `*/${intervalMin} * * * * ${runtime} ${binPath} _poll ${id} ${type} ${tag}`;

  let crontab = getCrontab();
  if (crontab.includes(`capy-watch:${id}`)) return false;

  crontab = crontab.trimEnd() + "\n" + cronLine + "\n";
  setCrontab(crontab);

  fs.writeFileSync(path.join(watchDir, `${id}.json`), JSON.stringify({
    id, type, intervalMin, created: new Date().toISOString(),
  }));
  return true;
}

export function remove(id: string): void {
  let crontab = getCrontab();
  const lines = crontab.split("\n").filter(l => !l.includes(`capy-watch:${id}`));
  setCrontab(lines.join("\n") + "\n");
  try { fs.unlinkSync(path.join(config.WATCH_DIR, `${id}.json`)); } catch {}
}

export function list(): WatchEntry[] {
  try {
    return fs.readdirSync(config.WATCH_DIR)
      .filter(f => f.endsWith(".json"))
      .map(f => JSON.parse(fs.readFileSync(path.join(config.WATCH_DIR, f), "utf8")));
  } catch { return []; }
}

export function notify(text: string): boolean {
  const cfg = config.load();
  const cmd = cfg.notifyCommand;
  if (!cmd) return false;
  try {
    execSync(cmd.replace("{text}", shellEscape(text)), {
      timeout: 15000, stdio: "pipe",
    });
    return true;
  } catch { return false; }
}
