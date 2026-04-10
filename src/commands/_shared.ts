import type { ArgsDef } from "citty";

export const modelArgs = {
  model:  { type: "string",  description: "Model ID override" },
  opus:   { type: "boolean", description: "Use claude-opus-4-6" },
  sonnet: { type: "boolean", description: "Use claude-sonnet-4-6" },
  mini:   { type: "boolean", description: "Use gpt-5.4-mini" },
  fast:   { type: "boolean", description: "Use gpt-5.4-fast" },
  kimi:   { type: "boolean", description: "Use kimi-k2.5" },
  glm:    { type: "boolean", description: "Use glm-5" },
  gemini: { type: "boolean", description: "Use gemini-3.1-pro" },
  grok:   { type: "boolean", description: "Use grok-4.1-fast" },
  qwen:   { type: "boolean", description: "Use qwen-3-coder" },
} as const satisfies ArgsDef;

export const jsonArg = {
  json: { type: "boolean", description: "Machine-readable JSON output", default: false },
} as const satisfies ArgsDef;

export function shellEscape(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

export function isThreadId(id: string): boolean {
  return id.length > 20 || (id.length > 10 && !id.match(/^[A-Z]+-\d+$/));
}

export function resolveModel(args: Record<string, unknown>): string | null {
  if (args.model) return String(args.model);
  if (args.opus)   return "claude-opus-4-6";
  if (args.sonnet) return "claude-sonnet-4-6";
  if (args.mini)   return "gpt-5.4-mini";
  if (args.fast)   return "gpt-5.4-fast";
  if (args.kimi)   return "kimi-k2.5";
  if (args.glm)    return "glm-5";
  if (args.gemini) return "gemini-3.1-pro";
  if (args.grok)   return "grok-4.1-fast";
  if (args.qwen)   return "qwen-3-coder";
  return null;
}
