// The READMEs must match the repository: every file they tell you to copy exists, the settings example parses,
// and the sample block message is what the hook really prints. Run: node --test tests/*.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { decide, fromClaudeCode, loadRules } from "../core/guard-core.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const SAMPLE = { tool_name: "Bash", tool_input: { command: "git push --force origin main" }, cwd: "/home/dev/myapp" };

for (const [file, lang] of [["README.md", "en"], ["README.ja.md", "ja"]]) {
  const text = readFileSync(join(REPO, file), "utf8");

  test(`${file}: every file it copies exists`, () => {
    const names = new Set([...text.matchAll(/(?:\.\\|\b)((?:cline|claude-code|core)[\\/][\w.-]+|rules\.json)\b/g)].map((m) => m[1].replace(/\\/g, "/")));
    assert.ok(names.size >= 6, [...names].join(" "));
    for (const n of names) assert.ok(existsSync(join(REPO, n)), n);
  });

  test(`${file}: the sample block message is the real one`, () => {
    const reason = decide(fromClaudeCode(SAMPLE, SAMPLE.cwd), loadRules(join(REPO, "rules.json"), lang)).reason;
    assert.ok(text.includes(reason), reason);
  });

  test(`${file}: the harmless check command really is blocked`, () => {
    const call = { ...SAMPLE, tool_input: { command: "git config --global --get user.name" } };
    assert.ok(text.includes("git config --global --get user.name"));
    assert.equal(decide(fromClaudeCode(call, call.cwd), loadRules(join(REPO, "rules.json"), lang)).allow, false);
  });

  test(`${file}: store links are placeholders or the real pages`, () => {
    const real = {
      gumroad: /https:\/\/shachilab\.gumroad\.com\/l\/[A-Za-z0-9_-]+/,
      booth: /https:\/\/shachilab\.booth\.pm\/items\/\d+/,
      "zenn-book": /https:\/\/zenn\.dev\/shacikku3\/books\/[A-Za-z0-9_-]+/,
    };
    for (const [name, re] of Object.entries(real)) assert.ok(text.includes(`<!-- link: ${name} -->`) || re.test(text), name);
  });
}

test("settings.example.json parses and keeps matcher * and || exit 2", () => {
  const s = JSON.parse(readFileSync(join(REPO, "claude-code", "settings.example.json"), "utf8"));
  const h = s.hooks.PreToolUse[0];
  assert.equal(h.matcher, "*");
  assert.match(h.hooks[0].command, /agent-guard-lite\/guard\.mjs" \|\| exit 2$/);
});

test("the lite edition stays lite: no settings file, no logs, no doctor", () => {
  for (const f of ["guard.config.json", "tools/doctor.mjs", "config/rules.default.json"]) assert.ok(!existsSync(join(REPO, f)), f);
  for (const f of ["core/guard-core.mjs", "cline/guard.mjs", "claude-code/guard.mjs"]) assert.doesNotMatch(readFileSync(join(REPO, f), "utf8"), /guard\.config\.json"|calls\.log|appendFileSync/, f);
});
