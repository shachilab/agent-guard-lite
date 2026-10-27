#!/usr/bin/env node
// agent-guard-lite — Cline PreToolUse hook (called by PreToolUse.ps1 on Windows, PreToolUse on Linux/WSL/macOS).
//
// Reads Cline's hook payload from stdin and writes one JSON object to stdout:
//   allowed -> {}
//   blocked -> {"cancel":true,"errorMessage":"..."}   (Cline aborts the tool call before the approval button)
//
// Anything that goes wrong here (broken rules.json, unreadable payload, missing file) blocks the call.
//
// Installed layout (everything in one folder, e.g. <Documents>\Cline\Hooks):
//   PreToolUse.ps1 / PreToolUse, guard.mjs, guard-core.mjs, rules.json
// The repository layout (cline/, core/, rules.json) also works, so the tests can run it in place.

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

const FAIL_MESSAGE = {
  ja: "【安全フックで停止】安全フックの判定でエラーが起きたため、念のため止めました",
  en: "[SAFETY HOOK] Blocked: the safety hook hit an error, so this call was stopped as a precaution",
};

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
  const language = process.env.AGENT_GUARD_LANG === "ja" ? "ja" : "en";
  let result;
  try {
    const payload = JSON.parse((await readStdin()).replace(/^﻿/, ""));
    const core = await import(pathToFileURL(locate("guard-core.mjs", ["core", "guard-core.mjs"])).href);
    const config = core.loadRules(locate("rules.json", ["rules.json"]), language);
    const verdict = core.decide(core.fromCline(payload), config);
    result = verdict.allow ? {} : { cancel: true, errorMessage: verdict.reason };
  } catch (e) {
    const msg = String(e?.message ?? e).replace(/\s+/g, " ").slice(0, 200);
    result = { cancel: true, errorMessage: `${FAIL_MESSAGE[language]} (${msg})` };
  }
  process.stdout.write(JSON.stringify(result));
}

main();
