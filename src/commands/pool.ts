import { defineCommand } from "citty";
import { jsonArg } from "./_shared.js";

const status = defineCommand({
  meta: { name: "status", description: "Warm pool config and status" },
  args: { ...jsonArg },
  async run({ args }) {
    const api = await import("../api.js");
    const fmt = await import("../output.js");
    const { log } = await import("@clack/prompts");

    const pool = await api.getWarmPool();
    if (args.json) { fmt.out(pool); return; }

    log.info(`Warm pool: ${pool.enabled ? "enabled" : "disabled"}`);
    console.log(`  Target size:  ${pool.targetSize}`);
    console.log(`  Max age:      ${pool.maxAgeMinutes}min`);
    if (pool.branch) console.log(`  Branch:       ${pool.branch}`);
    if (pool.setupCommands?.length) {
      console.log(`  Setup:        ${pool.setupCommands.length} commands`);
      pool.setupCommands.forEach(c => console.log(`    $ ${c}`));
    }
  },
});

const set = defineCommand({
  meta: { name: "set", description: "Update warm pool config" },
  args: {
    enabled: { type: "boolean", description: "Enable/disable" },
    size: { type: "string", description: "Target pool size" },
    age: { type: "string", description: "Max VM age in minutes" },
    branch: { type: "string", description: "Branch for pool VMs" },
    ...jsonArg,
  },
  async run({ args }) {
    const api = await import("../api.js");
    const fmt = await import("../output.js");
    const { log } = await import("@clack/prompts");

    const update: Record<string, unknown> = {};
    if (args.enabled !== undefined) update.enabled = args.enabled;
    if (args.size) update.targetSize = parseInt(args.size);
    if (args.age) update.maxAgeMinutes = parseInt(args.age);
    if (args.branch) update.branch = args.branch;

    const pool = await api.updateWarmPool(update as any);
    if (args.json) { fmt.out(pool); return; }
    log.success(`Updated: size=${pool.targetSize}, age=${pool.maxAgeMinutes}min, enabled=${pool.enabled}`);
  },
});

const test = defineCommand({
  meta: { name: "test", description: "Test VM boot with setup commands" },
  args: { ...jsonArg },
  async run({ args }) {
    const api = await import("../api.js");
    const fmt = await import("../output.js");
    const { log } = await import("@clack/prompts");

    const result = await api.testWarmPool();
    if (args.json) { fmt.out(result); return; }
    log.success(`Test VM started: ${result.instanceId} [${result.status}]`);
    log.info(`Check status: capy pool instance ${result.instanceId}`);
  },
});

const instances = defineCommand({
  meta: { name: "instances", description: "List warm pool VMs", alias: "ls" },
  args: {
    status: { type: "positional", required: false, description: "Filter: ready, provisioning, failed, claimed" },
    ...jsonArg,
  },
  async run({ args }) {
    const api = await import("../api.js");
    const fmt = await import("../output.js");

    const list = await api.listWarmPoolInstances({ status: args.status });
    if (args.json) { fmt.out(list); return; }
    if (!list.length) { console.log("No instances."); return; }
    fmt.table(["ID", "STATUS", "CREATED"], list.map(i => [
      i.id.slice(0, 16), i.status, i.createdAt || "?",
    ]));
  },
});

const instance = defineCommand({
  meta: { name: "instance", description: "VM instance detail + logs" },
  args: {
    id: { type: "positional", description: "Instance ID", required: true },
    ...jsonArg,
  },
  async run({ args }) {
    const api = await import("../api.js");
    const fmt = await import("../output.js");
    const { log } = await import("@clack/prompts");

    const data = await api.getWarmPoolInstance(args.id);
    if (args.json) { fmt.out(data); return; }
    log.info(`Instance: ${data.id}\nStatus:   ${data.status}\nCreated:  ${data.createdAt || "?"}`);
    if (data.claimedAt) console.log(`Claimed:  ${data.claimedAt}`);
    if (data.logs) {
      console.log(`\nLogs:\n${data.logs}`);
    }
  },
});

const clear = defineCommand({
  meta: { name: "clear", description: "Clear all warm pool VMs" },
  args: {
    replenish: { type: "boolean", description: "Replenish after clearing", default: false },
    ...jsonArg,
  },
  async run({ args }) {
    const api = await import("../api.js");
    const fmt = await import("../output.js");
    const { log } = await import("@clack/prompts");

    const result = await api.clearWarmPool({ replenish: args.replenish });
    if (args.json) { fmt.out(result); return; }
    log.success(`Pool cleared.${args.replenish ? " Replenishing..." : ""}`);
  },
});

export default defineCommand({
  meta: { name: "pool", description: "Manage warm pool VMs" },
  default: "status",
  subCommands: { status, set, test, instances, instance, clear },
});
