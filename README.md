# agent-guard-lite

A small, fail-closed safety hook for **Cline** and **Claude Code**. It runs before every tool call your coding agent makes and stops the ones that reach outside your project: pushing code, piping a script from the internet into a shell, changing global settings, reading your home folder, editing `.git` or `.claude`.

It decides by **what a call contains, not what the tool is called**. When Cline 4.1.25 renamed its tools and changed the shape of their input, guards that matched on tool names quietly stopped working. This one kept blocking, because it looks for commands, paths and patches wherever they appear.

```
[SAFETY HOOK] Blocked: git push / remote change (git push --force origin main). If this is really needed, explain why to the user and let them do it themselves.
```

## What it blocks

Any command, in any tool, that matches one of these:

| Area | Examples |
| --- | --- |
| Sending code or data out | `git push`, `git remote set-url`, `npm publish`, `docker push`, an inline `requests.post(...)` |
| Downloading and running | `curl ... \| sh`, `wget`, `Invoke-WebRequest`, `certutil -urlcache` |
| Global or system changes | `npm install -g`, `git config --global`, `setx`, `reg add`, `Set-ExecutionPolicy`, `Set-MpPreference` |
| Admin rights and tricks | `sudo`, `runas`, `-Verb RunAs`, `powershell -enc ...`, `shutdown` |

Plus, built into the engine:

- **Paths outside the project**: absolute paths, `..`, `~`, `$HOME`, `%USERPROFILE%`, `$env:APPDATA`, network shares. Reads and writes alike. `rm -rf /some/other/dir` is stopped because of the path, not the `rm`.
- **Protected folders inside the project**: `.git`, `.claude`, `.clinerules`, `.cline`, `.vscode`, `.clineignore`, `CLAUDE.md` cannot be written.
- **Built-in web tools** (Claude Code's WebFetch / WebSearch, Cline's browser). MCP tools are not touched.
- **Fail closed**: no workspace, unreadable input, a broken `rules.json`, a missing file, Node.js not found, the script crashing — all of these block the call instead of waving it through.

Everyday work passes: `npm test`, `npm install`, `git status`, `git commit`, reading and writing files in the project.

## Requirements

- Node.js on your `PATH` (tested with v22). If `node -v` prints a version, you're set.
- Cline with Hooks support, or Claude Code. The engine is the one the author runs every day with Cline 4.1.25 on Windows; the other setups are covered by the tests but less battle-tested, so do the check below.

## Install for Claude Code

Linux, WSL, macOS:
```sh
mkdir -p ~/.claude/hooks/agent-guard-lite
cp claude-code/guard.mjs core/guard-core.mjs rules.json ~/.claude/hooks/agent-guard-lite/
```
Windows (PowerShell):
```powershell
$dest = Join-Path $HOME '.claude\hooks\agent-guard-lite'
New-Item -ItemType Directory -Force $dest | Out-Null
Copy-Item .\claude-code\guard.mjs, .\core\guard-core.mjs, .\rules.json $dest
```

Then merge the `"hooks"` block from `claude-code/settings.example.json` into `~/.claude/settings.json` (copy it as is if you have no settings file yet). Keep both details:

- `"matcher": "*"` sends every tool through the hook, including tools that get renamed later.
- `|| exit 2` blocks the call if Node.js or the script is missing. Claude Code **only blocks on exit code 2**; any other failure lets the call through.

Restart Claude Code. To uninstall, remove the entry from `settings.json` **first**, then delete the folder (the other way round, `|| exit 2` blocks everything).

## Install for Cline

Cline loads hooks from `Cline\Hooks` in your **real** Documents folder. If Documents was ever moved (OneDrive backup does this), that is not `C:\Users\<you>\Documents`. Ask Windows where it is:

```powershell
$dest = Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'Cline\Hooks'
New-Item -ItemType Directory -Force $dest | Out-Null
Copy-Item .\cline\PreToolUse.ps1, .\cline\guard.mjs, .\core\guard-core.mjs, .\rules.json $dest
```

Linux, WSL, macOS (only confirmed on Windows so far, so do check it afterwards):
```sh
dest="$(xdg-user-dir DOCUMENTS 2>/dev/null || echo "$HOME/Documents")/Cline/Hooks"
mkdir -p "$dest"
cp cline/PreToolUse cline/guard.mjs core/guard-core.mjs rules.json "$dest/"
chmod +x "$dest/PreToolUse"
```

In Cline's **Feature Settings**, turn **Hooks** on, then reload VS Code (`Ctrl+Shift+P` → `Developer: Reload Window`). With Hooks off, nothing is ever called.

## Check that it actually works

A hook that is installed but never called protects nothing, and testing the script by hand doesn't prove the agent calls it. Ask your agent to run this harmless, read-only command:

```
git config --global --get user.name
```

If it's stopped with `[SAFETY HOOK] Blocked: ...` before any approval prompt, you're protected. If it runs, the hook is not being called: check the folder, the Hooks switch, and that `node` works in a new terminal. Do this again after every Cline or Claude Code update.

Messages are in English. For Japanese, set the environment variable `AGENT_GUARD_LANG=ja` (and restart VS Code / Claude Code).

## Limits

- It matches commands with regular expressions and inspects paths. It is a seatbelt, not a sandbox: a script the agent writes inside the project and then runs is not looked into.
- It only works when the agent calls it. Check after updates.
- A tool call with neither a path nor a command (an MCP tool, a code search) passes.
- The rules are fixed in `rules.json`. You can edit that file, but a typo blocks everything (on purpose).

## Run the tests

```sh
node --test tests/*.test.mjs
```
No dependencies. The hook tests start the entry points as child processes and use `/bin/sh`, so run them on Linux, WSL or macOS.

## Want more?

The **AI Agent Safety Kit** is the full version this is cut from:

- A settings file (`guard.config.json`) to switch rules off, add your own, and allow specific folders, without touching the rule file
- 41 rules, including Linux and WSL (`apt`, `systemctl`, `crontab`, ...), services, scheduled tasks, firewall, registry reads, SSH and file transfer
- `doctor`: a self-check that finds the real hook folder, checks every file and setting, and runs a live block test
- `calls.log` / `blocked.log`, so you can see that the agent is calling the hook and what it stopped
- A step-by-step guide to verifying it on your own machine, rule templates for Cline and `CLAUDE.md`
- The full test suite (215 tests), plus two extras: a read-only web-reader MCP server and local code completion for VS Code

This free version blocks the basics. The paid kit is about knowing it still works after your agent updates itself: a Cline auto-update once changed the hook payload and silently switched my guard off, and the kit's checks and tests are built around catching that.

Get it on Gumroad: <!-- link: gumroad -->
日本語版は BOOTH で：<!-- link: booth -->

The story behind it (in Japanese): a book on running a local AI coding setup safely, on Zenn. https://zenn.dev/shacikku3/books/local-ai-coding

Also from shachilab: the **AI Office Starter Kit** ($12), the procedures and shared files I use to run my side business with scheduled Claude agents, including the rules that keep them away from publish and payment buttons: https://shachilab.gumroad.com/l/ai-office-kit

## License

MIT © 2026 shachilab. See [LICENSE](LICENSE).
