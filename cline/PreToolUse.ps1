# agent-guard-lite - Cline PreToolUse hook entry point (Windows Cline only looks for "<HookName>.ps1").
# The actual decision is made by guard.mjs in the same folder.
# If guard.mjs cannot run or returns nothing, fail closed (cancel the tool call).
# NOTE: keep this file ASCII-only. Windows PowerShell 5.1 reads BOM-less files as ANSI.
$utf8 = New-Object System.Text.UTF8Encoding($false)
try { [Console]::InputEncoding = $utf8 } catch {}
try { [Console]::OutputEncoding = $utf8 } catch {}
$OutputEncoding = $utf8

$fail = '{"cancel":true,"errorMessage":"[SAFETY HOOK] guard.mjs could not run, so this tool call was stopped as a precaution. Tell the user."}'

try {
    $payload = [Console]::In.ReadToEnd()
    $result = ($payload | & node (Join-Path $PSScriptRoot 'guard.mjs') 2>$null) -join "`n"
    if ($LASTEXITCODE -ne 0 -or -not $result -or -not $result.Trim().StartsWith('{')) { $result = $fail }
} catch {
    $result = $fail
}

[Console]::Out.Write($result)
exit 0
