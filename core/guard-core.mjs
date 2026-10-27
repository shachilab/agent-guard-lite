// agent-guard-lite — decision engine (shared by the Cline and Claude Code hooks).
// Same engine as the full AI Agent Safety Kit; the lite edition ships a smaller rule set and no settings file.
//
// decide(call, config) looks at what a tool call actually contains, not at what the
// tool is called. Agent updates rename tools and reshape their input (Cline 4.1.23 ->
// 4.1.25 did both), and a guard that only matches known names silently stops working.
//
//   call   = { tool, input, roots, cwd }   (use fromCline() / fromClaudeCode() to build it)
//   config = loadRules(file, language)     (rules.json; language "en" or "ja")
//
// Result: { allow: true } or { allow: false, reason }.
// Fail closed: anything we cannot read or classify safely is blocked, never waved through.

import { readFileSync } from "node:fs";
import { join, posix, win32 } from "node:path";

// ---------- config ----------

const CONFIG_KEYS = new Set(["$comment", "language", "disableRules", "extraRules", "allowPaths", "protectedInProject", "blockBuiltinWeb"]);

// The lite edition has no settings file: the rules come from rules.json, the language from AGENT_GUARD_LANG.
export function loadRules(file, language = "en") {
  // A broken rules.json throws, and the caller blocks.
  const defaults = JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
  return buildConfig(defaults, { language });
}

export function buildConfig(defaults, user = {}) {
  if (!defaults || !Array.isArray(defaults.rules)) throw new Error("rules.default.json has no rules array");
  if (typeof user !== "object" || user === null || Array.isArray(user)) throw new Error("guard.config.json must be a JSON object");
  for (const k of Object.keys(user)) if (!CONFIG_KEYS.has(k)) throw new Error(`guard.config.json: unknown setting "${k}"`);

  const disabled = new Set(user.disableRules ?? []);
  const known = new Set(defaults.rules.map((r) => r.id));
  for (const id of disabled) if (!known.has(id)) throw new Error(`guard.config.json: disableRules has unknown rule id "${id}"`);

  const rules = [...defaults.rules.filter((r) => !disabled.has(r.id)), ...(user.extraRules ?? [])].map(compileRule);
  const language = user.language ?? "ja";
  if (language !== "ja" && language !== "en") throw new Error(`language must be "ja" or "en" (AGENT_GUARD_LANG)`);

  return {
    language,
    rules,
    allowPaths: (user.allowPaths ?? []).map(String),
    protectedInProject: (user.protectedInProject ?? defaults.protectedInProject ?? []).map((s) => String(s).toLowerCase()),
    blockBuiltinWeb: user.blockBuiltinWeb ?? true,
  };
}

function compileRule(r) {
  if (!r || typeof r.id !== "string" || typeof r.pattern !== "string") throw new Error(`rule needs "id" and "pattern": ${JSON.stringify(r)}`);
  const flags = r.flags ?? "i";
  const label = typeof r.label === "string" ? { ja: r.label, en: r.label } : { ja: r.label?.ja ?? r.id, en: r.label?.en ?? r.label?.ja ?? r.id };
  // An invalid regex throws here, so a typo in rules.json blocks everything instead of disabling the rule.
  return { id: r.id, re: new RegExp(r.pattern, flags), unless: (r.unless ?? []).map((u) => new RegExp(u, flags)), label };
}

// ---------- messages ----------

const TEXT = {
  ja: {
    prefix: "【安全フックで停止】",
    suffix: "。必要ならユーザーに理由を説明し、ユーザー自身に実施してもらうこと。",
    noRoots: "ワークスペースが開かれていないため許可できない",
    outside: "プロジェクト外のファイルへのアクセス",
    outsidePath: "プロジェクト外のパス",
    outsideDots: "プロジェクト外へ出るパス",
    outsideRef: "プロジェクト外の場所を参照するコマンド",
    protected: "設定フォルダの変更",
    noWriteTarget: "書き込み先を特定できない",
    noPatchTarget: "パッチの対象ファイルを特定できない",
    web: "組み込みの Web 取得/ブラウザは使わない（Web を見る必要があれば、ユーザーに頼むこと）",
    unreadable: "ツールの中身を読み取れない",
  },
  en: {
    prefix: "[SAFETY HOOK] Blocked: ",
    suffix: ". If this is really needed, explain why to the user and let them do it themselves.",
    noRoots: "no workspace folder is open, so nothing can be allowed",
    outside: "file access outside the project",
    outsidePath: "path outside the project",
    outsideDots: "path that climbs out of the project",
    outsideRef: "command that refers to a location outside the project",
    protected: "change to a protected config folder",
    noWriteTarget: "cannot tell which file would be written",
    noPatchTarget: "cannot tell which files the patch touches",
    web: "built-in web fetch / browser is not allowed (ask the user if you need something from the web)",
    unreadable: "cannot read the tool input",
  },
};

export function blockMessage(reason, language = "ja") {
  const t = TEXT[language] ?? TEXT.ja;
  return `${t.prefix}${reason}${t.suffix}`;
}

// ---------- payload adapters ----------

// Cline hands strings like '{"path":"a"}' or '["ls"]' for structured parameters (VS Code build); turn them back into JSON.
function unstringify(v) {
  if (typeof v === "string" && /^\s*[[{]/.test(v)) {
    try {
      return JSON.parse(v);
    } catch {}
  }
  return v;
}
function unstringifyAll(params) {
  if (typeof params === "string") return unstringify(params);
  if (!params || typeof params !== "object" || Array.isArray(params)) return params;
  return Object.fromEntries(Object.entries(params).map(([k, v]) => [k, unstringify(v)]));
}

// Cline (4.1.23: tool_call.input / 4.1.25: preToolUse.parameters)
export function fromCline(payload) {
  const roots = (payload?.workspaceRoots ?? []).filter((r) => typeof r === "string" && r);
  return {
    tool: String(payload?.preToolUse?.toolName ?? payload?.tool_call?.name ?? ""),
    input: payload?.tool_call?.input ?? unstringifyAll(payload?.preToolUse?.parameters) ?? payload?.preToolUse?.input,
    roots,
    cwd: payload?.cwd || roots[0] || "",
  };
}

// Claude Code (PreToolUse: { tool_name, tool_input, cwd, ... }). Claude Code gives no workspace list,
// so the project is $CLAUDE_PROJECT_DIR (set for hook commands), falling back to the payload's cwd.
// Glob's pattern can itself point outside the project ("/etc/**", "../**"), so an absolute or
// climbing pattern is also checked as a path.
export function fromClaudeCode(payload, projectDir = process.env.CLAUDE_PROJECT_DIR) {
  const cwd = typeof payload?.cwd === "string" ? payload.cwd : "";
  const root = projectDir || cwd;
  let input = payload?.tool_input;
  const pattern = input && typeof input === "object" && !Array.isArray(input) ? input.pattern : undefined;
  if (/^glob$/i.test(String(payload?.tool_name ?? "")) && typeof pattern === "string" && /^([\\/~]|[A-Za-z]:)|(^|[\\/])\.\.([\\/]|$)/.test(pattern)) {
    input = { ...input, paths: [...(input.path ? [input.path] : []), pattern] };
  }
  return { tool: String(payload?.tool_name ?? ""), input, roots: root ? [root] : [], cwd: cwd || root };
}

// ---------- paths ----------

const isWinPath = (p) => /^[A-Za-z]:([\\/]|$)/.test(p) || /^\\\\/.test(p);

// Windows-style roots are compared with Windows rules (case-insensitive, either slash);
// everything else with POSIX rules. This keeps the engine testable on Linux with Windows payloads.
function makePathTools(roots, cwd) {
  const win = roots.length ? roots.some(isWinPath) : isWinPath(cwd);
  const lib = win ? win32 : posix;
  const norm = (p) => {
    const s = lib.resolve(p).replace(/[\\/]+$/, "") || lib.sep;
    return win ? s.toLowerCase() : s;
  };
  const base = cwd || roots[0] || lib.sep;
  const normRoots = roots.map(norm);
  const inside = (p, extra = []) => {
    const abs = norm(lib.isAbsolute(p) ? p : lib.resolve(base, p));
    return [...normRoots, ...extra].some((r) => abs === r || abs.startsWith(r.endsWith(lib.sep) ? r : r + lib.sep));
  };
  return { win, lib, norm, inside };
}

function collectPaths(v, out = []) {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => collectPaths(x, out));
  else if (v && typeof v === "object") {
    for (const k of PATH_KEYS) if (k in v) collectPaths(v[k], out);
  }
  return out;
}

function patchPaths(patch) {
  return [...String(patch).matchAll(/^\*\*\*\s+(?:Add|Update|Delete) File:\s*(.+?)\s*$|^\*\*\*\s+Move to:\s*(.+?)\s*$/gm)].map((m) => m[1] || m[2]);
}

function commandStrings(input) {
  // Anything that is not a string (or a {command, args} object) comes back as null, and checkCommand blocks it.
  const one = (c) =>
    typeof c === "string" ? c : c && typeof c === "object" && typeof c.command === "string" ? [c.command, ...(Array.isArray(c.args) ? c.args : [])].map(String).join(" ") : null;
  if (typeof input === "string") return [input];
  if (Array.isArray(input)) return input.map(one);
  const c = unstringify(input.commands ?? input.command ?? input.cmd);
  return Array.isArray(c) ? c.map(one) : [one(c)];
}

// ---------- what the input looks like ----------

const PATH_KEYS = ["path", "file_path", "filePath", "files", "file_paths", "paths", "absolutePath", "directory", "notebook_path", "target_file"];
const COMMAND_KEYS = ["command", "commands", "cmd"];
const WRITE_KEYS = ["content", "contents", "diff", "new_str", "new_string", "old_string", "edits", "new_source", "text"];
const PATCH_KEYS = ["patch", "input"];
const URL_KEYS = ["url", "urls", "query"];

// Names are only a hint. They can make a call stricter (treat as write / as web), never looser.
const WRITE_NAMES = /^(editor|write_to_file|replace_in_file|new_rule|write|edit|multiedit|notebookedit|create_file|str_replace\w*|apply_diff|insert_content)$/i;
const WEB_NAMES = /^(fetch_web_content|web_fetch|webfetch|web_search|websearch|browser_action|browser\w*)$/i;
const PATCH_NAMES = /^apply_patch$/i;

const has = (o, keys) => o && typeof o === "object" && !Array.isArray(o) && keys.some((k) => k in o);
const looksLikePatch = (s) => typeof s === "string" && /^\*\*\*\s+(Begin Patch|(Add|Update|Delete) File:)/m.test(s);

// ---------- checks ----------

export function decide(call, config) {
  const L = TEXT[config.language] ?? TEXT.ja;
  const no = (reason) => ({ allow: false, reason: blockMessage(reason, config.language) });
  const ok = { allow: true };

  const tool = String(call?.tool ?? "");
  const roots = (call?.roots ?? []).filter(Boolean);
  const cwd = call?.cwd || roots[0] || "";
  let input = call?.input;
  if (input === undefined || input === null) input = {};
  if (typeof input !== "string" && typeof input !== "object") return no(L.unreadable);

  const pt = makePathTools(roots, cwd);
  const allowExtra = config.allowPaths.map(pt.norm);
  const needRoots = () => (roots.length === 0 ? no(L.noRoots) : null);

  const checkPaths = (paths, write) => {
    for (const p of paths) {
      if (typeof p !== "string" || !p) return no(write ? L.noWriteTarget : L.unreadable);
      // "~/..." is the home folder, never the project (resolving it as a relative path would wave it through).
      if (/^~([\\/]|$)/.test(p) || !pt.inside(p, allowExtra)) return no(`${L.outside}: ${p}`);
      if (write && isProtected(p, config.protectedInProject)) return no(`${L.protected}: ${p}`);
    }
    return null;
  };

  // 1. Built-in web tools: blocked by name (MCP tools are not affected).
  if (config.blockBuiltinWeb && WEB_NAMES.test(tool)) return no(L.web);

  // 2. Anything carrying a command is checked as a command, whatever the tool is called.
  if (typeof input === "string" && !looksLikePatch(input) && !WRITE_NAMES.test(tool) && !PATCH_NAMES.test(tool)) {
    // A bare string input: treat it as a command (the stricter reading).
    return needRoots() ?? checkCommands([input], config, pt, allowExtra, L, no) ?? ok;
  }
  if (has(input, COMMAND_KEYS)) {
    return needRoots() ?? checkCommands(commandStrings(input), config, pt, allowExtra, L, no) ?? ok;
  }

  // 3. Patches (apply_patch style).
  const patchText = typeof input === "string" ? input : PATCH_KEYS.map((k) => input[k]).find(looksLikePatch);
  if (PATCH_NAMES.test(tool) || patchText) {
    const paths = patchPaths(patchText ?? (typeof input === "string" ? input : JSON.stringify(input)));
    if (paths.length === 0) return no(L.noPatchTarget);
    return needRoots() ?? checkPaths(paths, true) ?? ok;
  }

  // 4. File access: any recognised path key. Writing is decided by the name OR the presence of content.
  const write = WRITE_NAMES.test(tool) || has(input, WRITE_KEYS);
  const paths = collectPaths(input);
  if (paths.length > 0) return needRoots() ?? checkPaths(paths, write) ?? ok;
  if (WRITE_NAMES.test(tool)) return no(L.noWriteTarget);

  // 5. Built-in web tools that we did not know by name but that carry a URL.
  if (config.blockBuiltinWeb && has(input, ["url", "urls"]) && !tool.includes("__") && !tool.startsWith("mcp")) return no(L.web);

  // 6. Nothing path-like or command-like (codebase search, ask_question, MCP tools, ...).
  return ok;
}

function isProtected(p, names) {
  const segs = String(p).split(/[\\/]+/).map((s) => s.toLowerCase());
  return segs.some((s) => names.includes(s));
}

function checkCommands(cmds, config, pt, allowExtra, L, no) {
  for (const cmd of cmds) {
    const r = checkCommand(cmd, config, pt, allowExtra, L, no);
    if (r) return r;
  }
  return null;
}

const OUTSIDE_REFS = /(%(USERPROFILE|APPDATA|LOCALAPPDATA|PROGRAMDATA|PROGRAMFILES|WINDIR|SYSTEMROOT|HOMEPATH|HOMEDRIVE|PUBLIC|TEMP|TMP|ALLUSERSPROFILE)%|\$env:(USERPROFILE|APPDATA|LOCALAPPDATA|ProgramData|ProgramFiles|windir|SystemRoot|HOMEPATH|HOMEDRIVE|PUBLIC|TEMP|TMP|ALLUSERSPROFILE)\b|\$HOME\b|\$\{HOME\}|\$PROFILE\b|(^|[\s"'=(])~([\\/]|$|\s)|\\\\[A-Za-z0-9._-]+\\)/i;
const POSIX_OK = new Set(["/dev/null", "/dev/stdout", "/dev/stderr", "/dev/stdin"]);

function checkCommand(cmd, config, pt, allowExtra, L, no) {
  if (typeof cmd !== "string") return no(L.unreadable);
  const short = cmd.slice(0, 120);
  const quote = (s) => (config.language === "en" ? ` (${s})` : `（${s}）`);
  for (const rule of config.rules) {
    if (rule.re.test(cmd) && !rule.unless.some((u) => u.test(cmd))) return no(`${rule.label[config.language] ?? rule.label.ja}${quote(short)}`);
  }
  if (OUTSIDE_REFS.test(cmd)) return no(`${L.outsideRef}${quote(short)}`);

  // Absolute Windows paths: "C:\..." / C:/...
  const winAbs = [...cmd.matchAll(/"([A-Za-z]:[\\/][^"]*)"|'([A-Za-z]:[\\/][^']*)'|(?<![\w])([A-Za-z]:[\\/][^\s"'|;&<>(),]*)/g)].map((m) => m[1] || m[2] || m[3]);
  for (const p of winAbs) if (!pt.win || !pt.inside(p, allowExtra)) return no(`${L.outsidePath}: ${p}`);

  // Git Bash drive paths on Windows (Claude Code runs Bash commands there): /c/Users/... = C:\Users\...
  if (pt.win) {
    for (const m of cmd.matchAll(/(?:^|[\s"'=(<>|;&])\/([A-Za-z])(\/[^\s"'|;&<>()]*)/g)) {
      // Only "/c/..." with a slash after the letter: a bare "/c" is a switch (cmd /c, rd /s).
      const p = `${m[1]}:\\${m[2].slice(1).replace(/\//g, "\\")}`;
      if (!pt.inside(p, allowExtra)) return no(`${L.outsidePath}: /${m[1]}${m[2]}`);
    }
  }

  // Absolute POSIX paths (only meaningful when the workspace itself is POSIX; on Windows "/c" is a switch).
  if (!pt.win) {
    const posixAbs = [...cmd.matchAll(/(?:^|[\s"'=(<>|;&])(\/[^\s"'|;&<>()]*)/g)].map((m) => m[1]);
    for (const p of posixAbs) if (!POSIX_OK.has(p) && !pt.inside(p, allowExtra)) return no(`${L.outsidePath}: ${p}`);
  }

  // Relative paths that climb out with ..
  for (const m of cmd.matchAll(/(?:^|[\s"'=(])((?:[^\s"'|;&<>()]*[\\/])?\.\.(?:[\\/][^\s"'|;&<>()]*)?)/g)) {
    if (!pt.inside(m[1], allowExtra)) return no(`${L.outsideDots}: ${m[1]}`);
  }

  // Writes into protected config folders inside the project.
  const writes = /\b(Set-Content|Add-Content|Out-File|New-Item|Copy-Item|Move-Item|Remove-Item|Rename-Item|rm|del|erase|rmdir|rd|mv|cp|copy|move|ren|touch|tee|sed\s+-i)\b|>/i;
  if (writes.test(cmd)) {
    const names = config.protectedInProject.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
    if (names && new RegExp(`(^|[\\s"'=\\\\/])(${names})([\\s"'\\\\/]|$)`, "i").test(cmd)) return no(`${L.protected}${quote(short)}`);
  }
  return null;
}
