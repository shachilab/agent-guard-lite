#!/usr/bin/env node
// agent-guard-lite — Claude Code PreToolUse hook.
//
// Claude Code runs the command in settings.json for every tool call and hands it a JSON payload on stdin
// ({ tool_name, tool_input, cwd, ... }). The answer is the exit code:
//   allowed -> exit 0, no output      (Claude Code carries on with its normal permission checks)
//   blocked -> exit 2, reason on stderr (Claude Code cancels the call and shows the reason to Claude)
//
// Any other exit code is a "non-blocking error" in Claude Code, which would let the call through.
// So every failure here (broken rules.json, unreadable payload, missing file, a crash) ends with exit 2,
// and settings.json adds "|| exit 2" so a missing node or a missing file also blocks.
//
// Installed layout (everything in one folder, e.g. ~/.claude/hooks/agent-guard-lite):
//   guard.mjs, guard-core.mjs, rules.json
// The repository layout (claude-code/, core/, rules.json) also works, so the tests can run it in place.

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const language = process.env.AGENT_GUARD_LANG === "ja" ? "ja" : "en";

const FAIL_MESSAGE = {
  ja: "【安全フックで停止】安全フックの判定でエラーが起きたため、念のため止めました",
  en: "[SAFETY HOOK] Blocked: the safety hook hit an error, so this call was stopped as a precaution",
};

function block(reason) {
  process.stderr.write(reason + "\n");
  process.exit(2);
}

function fail(e) {
  const msg = String(e?.message ?? e).replace(/\s+/g, " ").slice(0, 200);
  block(`${FAIL_MESSAGE[language]} (${msg})`);
}

// A crash anywhere must still block.
process.on("uncaughtException", fail);
process.on("unhandledRejection", fail);

function locate(name, inRepo) {
  const a = join(HERE, name);
  return existsSync(a) ? a : join(HERE, "..", ...inRepo);
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let raw = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (d) => (raw += d));
    process.stdin.on("end", () => resolve(raw));
    process.stdin.on("error", reject);
  });
}

async function main() {
  try {
    const payload = JSON.parse((await readStdin()).replace(/^﻿/, ""));
    if (!payload || typeof payload.tool_name !== "string") throw new Error("payload has no tool_name");
    const core = await import(pathToFileURL(locate("guard-core.mjs", ["core", "guard-core.mjs"])).href);
    const config = core.loadRules(locate("rules.json", ["rules.json"]), language);
    const verdict = core.decide(core.fromClaudeCode(payload), config);
    if (!verdict.allow) block(verdict.reason);
  } catch (e) {
    fail(e);
  }
}

main();
