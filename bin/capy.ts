#!/usr/bin/env bun

import { defineCommand, runCommand } from "citty";
import { createRequire } from "node:module";
import { CapyError } from "../src/api.js";

const require = createRequire(import.meta.url);
const { version } = require("../package.json");

const main = defineCommand({
  meta: {
    name: "capy",
    version,
    description: "Agent orchestrator with quality gates",
  },
  subCommands: {
    captain:     () => import("../src/commands/agents.js").then(m => m.captain),
    build:       () => import("../src/commands/agents.js").then(m => m.build),
    threads:     () => import("../src/commands/threads.js").then(m => m.default),
    list:        () => import("../src/commands/tasks.js").then(m => m.list),
    get:         () => import("../src/commands/tasks.js").then(m => m.get),
    start:       () => import("../src/commands/tasks.js").then(m => m.start),
    stop:        () => import("../src/commands/tasks.js").then(m => m.stop),
    msg:         () => import("../src/commands/tasks.js").then(m => m.msg),
    diff:        () => import("../src/commands/diff-pr.js").then(m => m.diff),
    pr:          () => import("../src/commands/diff-pr.js").then(m => m.pr),
    models:      () => import("../src/commands/setup.js").then(m => m.models),
    tools:       () => import("../src/commands/setup.js").then(m => m.tools),
    status:      () => import("../src/commands/setup.js").then(m => m.status),
    review:      () => import("../src/commands/quality.js").then(m => m.review),
    "re-review": () => import("../src/commands/quality.js").then(m => m.reReview),
    approve:     () => import("../src/commands/quality.js").then(m => m.approve),
    retry:       () => import("../src/commands/quality.js").then(m => m.retry),
    watch:       () => import("../src/commands/monitoring.js").then(m => m.watch),
    unwatch:     () => import("../src/commands/monitoring.js").then(m => m.unwatch),
    watches:     () => import("../src/commands/monitoring.js").then(m => m.watches),
    wait:        () => import("../src/commands/monitoring.js").then(m => m.wait),
    _poll:       () => import("../src/commands/monitoring.js").then(m => m._poll),
    init:        () => import("../src/commands/setup.js").then(m => m.init),
    config:      () => import("../src/commands/setup.js").then(m => m.config),
  },
});

try {
  await runCommand(main, { rawArgs: process.argv.slice(2) });
} catch (e) {
  if (e instanceof CapyError) {
    if (process.argv.includes("--json")) {
      console.log(JSON.stringify({ error: { code: e.code, message: e.message } }));
    } else {
      console.error(`capy: ${e.message}`);
    }
    process.exit(1);
  }
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
}
