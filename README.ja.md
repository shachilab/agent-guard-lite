# agent-guard-lite（安全フックの無料版）

**Cline** と **Claude Code** のための、小さな安全フックです。AI エージェントがツールを使う直前に毎回呼ばれ、プロジェクトの外に手を出す操作を止めます（コードの push、インターネットから取ってきたスクリプトの実行、PC 全体の設定の変更、ホームフォルダの読み取り、`.git`・`.claude` の書き換えなど）。

判定は**ツールの名前ではなく、中身で**行います。Cline 4.1.25 でツールの名前と渡される情報の形が変わったとき、名前で判定していたフックは、何も言わずに効かなくなりました。このフックは、コマンド・パス・パッチがどこにあっても見つけて調べるので、止め続けられます。

```
【安全フックで停止】git の送信/リモート変更（git push --force origin main）。必要ならユーザーに理由を説明し、ユーザー自身に実施してもらうこと。
```
（日本語の文面は、環境変数 `AGENT_GUARD_LANG=ja` を設定したとき。初期値は英語）

## 止めるもの

どのツールでも、コマンドが次に当てはまれば止めます。

| 種類 | 例 |
| --- | --- |
| コードやデータを外に出す | `git push`、`git remote set-url`、`npm publish`、`docker push`、スクリプトの中の `requests.post(...)` |
| 取ってきて実行する | `curl ... \| sh`、`wget`、`Invoke-WebRequest`、`certutil -urlcache` |
| PC 全体の設定を変える | `npm install -g`、`git config --global`、`setx`、`reg add`、`Set-ExecutionPolicy`、`Set-MpPreference` |
| 管理者の権限・ごまかし | `sudo`、`runas`、`-Verb RunAs`、`powershell -enc ...`、`shutdown` |

判定本体にも、次の決まりが入っています。

- **プロジェクトの外のパス**：絶対パス・`..`・`~`・`$HOME`・`%USERPROFILE%`・`$env:APPDATA`・ネットワークの共有フォルダ。読むのも書くのも止めます（`rm -rf /別の/場所` は `rm` ではなく、パスで止まります）
- **プロジェクトの中の設定フォルダ**：`.git`・`.claude`・`.clinerules`・`.cline`・`.vscode`・`.clineignore`・`CLAUDE.md` は書き換えられません
- **組み込みの Web 取得**（Claude Code の WebFetch・WebSearch、Cline のブラウザ）。MCP のツールは対象外です
- **fail closed（判定できなければ止める）**：ワークスペースが無い・読めない入力・`rules.json` が壊れている・ファイルが足りない・Node.js が見つからない・スクリプトが落ちた、のどれでも、通さずに止めます

ふだんの作業は通ります：`npm test`、`npm install`、`git status`、`git commit`、プロジェクトの中のファイルの読み書き。

## 必要なもの

- Node.js（作者は v22 でテスト）。`node -v` で番号が出れば OK
- Hooks に対応した Cline、または Claude Code。判定本体は、作者が Windows の Cline 4.1.25 で毎日使っているものと同じです。ほかの組み合わせはテストで確かめていますが、実機での実績は少ないので、下の「本当に効いているか確かめる」を必ずやってください

## Claude Code に入れる

Linux・WSL・macOS：
```sh
mkdir -p ~/.claude/hooks/agent-guard-lite
cp claude-code/guard.mjs core/guard-core.mjs rules.json ~/.claude/hooks/agent-guard-lite/
```
Windows（PowerShell）：
```powershell
$dest = Join-Path $HOME '.claude\hooks\agent-guard-lite'
New-Item -ItemType Directory -Force $dest | Out-Null
Copy-Item .\claude-code\guard.mjs, .\core\guard-core.mjs, .\rules.json $dest
```

次に、`claude-code/settings.example.json` の `"hooks"` の部分を `~/.claude/settings.json` に足します（まだ無ければ、そのまま写してかまいません）。次の2つは消さないでください。

- `"matcher": "*"`：すべてのツールをフックに通します（あとで名前が変わったツールも）
- `|| exit 2`：Node.js やファイルが無いときにも止めます。Claude Code は**終了コード2のときだけ止まり**、ほかの失敗では通してしまいます

Claude Code を起動し直します。外すときは、**先に `settings.json` から消し**、そのあとでフォルダを消します（逆にすると `|| exit 2` で全部止まります）。

## Cline に入れる

Cline は、**本当の**「ドキュメント」フォルダの中の `Cline\Hooks` からフックを読みます。「ドキュメント」を移したことがあると（OneDrive のバックアップでも移ります）、`C:\Users\<名前>\Documents` ではありません。Windows に場所を聞いて入れます。

```powershell
$dest = Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'Cline\Hooks'
New-Item -ItemType Directory -Force $dest | Out-Null
Copy-Item .\cline\PreToolUse.ps1, .\cline\guard.mjs, .\core\guard-core.mjs, .\rules.json $dest
```

Linux・WSL・macOS（置き場所は Windows でしか確かめていません。入れたあと必ず確かめてください）：
```sh
dest="$(xdg-user-dir DOCUMENTS 2>/dev/null || echo "$HOME/Documents")/Cline/Hooks"
mkdir -p "$dest"
cp cline/PreToolUse cline/guard.mjs core/guard-core.mjs rules.json "$dest/"
chmod +x "$dest/PreToolUse"
```

Cline の **Feature Settings** で **Hooks** をオンにし、VS Code を読み込み直します（`Ctrl+Shift+P` → `Developer: Reload Window`）。Hooks がオフだと、フックは一度も呼ばれません。

## 本当に効いているか確かめる

入れただけで呼ばれていないフックは、何も守りません。スクリプトを手で動かして通っても、エージェントが呼んでいる証拠にはなりません。エージェントに、次の**読むだけで無害な**コマンドを頼んでください。

```
git config --global --get user.name
```

承認のボタンが出る前に `[SAFETY HOOK] Blocked: ...`（日本語なら `【安全フックで停止】`）で止まれば、守られています。そのまま動いたら、フックは呼ばれていません。置き場所・Hooks のスイッチ・新しいターミナルで `node` が動くかを見直してください。Cline や Claude Code を更新するたびに、もう一度確かめてください。

## 限界

- 正規表現でコマンドを調べ、パスを確かめるだけです。シートベルトであって、サンドボックスではありません。エージェントがプロジェクトの中にスクリプトを書いて実行すると、その中身は見えません
- エージェントが呼んだときだけ効きます。更新のたびに確かめてください
- パスもコマンドも持たないツール（MCP のツール、コードの検索など）は通します
- ルールは `rules.json` に固定です。書き換えはできますが、書き間違えると全部止まります（わざとそうしています）

## テスト

```sh
node --test tests/*.test.mjs
```
外部のパッケージは使いません。フックのテストは入口を子プロセスとして動かし、`/bin/sh` を使うので、Linux・WSL・macOS で動かしてください。

## もっと欲しい方へ

この無料版は、有料の **AIエージェント安全キット** から切り出したものです。有料版には次のものがあります。

- 設定ファイル（`guard.config.json`）：ルールファイルを触らずに、ルールを外す・足す・許すフォルダを決める
- 41 のルール（Linux・WSL の `apt`・`systemctl`・`crontab`、サービス・タスク・ファイアウォール・レジストリの読み取り・SSH やファイル転送など）
- 自己診断 `doctor`：本当のフックの場所を見つけ、ファイルと設定を全部調べ、実際に止まるかを試す
- `calls.log`・`blocked.log`：エージェントがフックを呼んでいるか、何を止めたかが見える
- 自分の PC で確かめる手順書、Cline のルールと `CLAUDE.md` のひな形
- テスト一式（215 件）と、おまけ2つ（読むだけの Web 参照 MCP、VS Code のローカル補完）

この無料版は基本を止めるだけです。有料版は「エージェントが更新されたあとも効いているか」を確かめることに力を入れています（作者は Cline の自動更新で渡される情報の形が変わり、フックが黙って効かなくなったことがあります）。

日本語版は BOOTH で：<!-- link: booth -->
英語版は Gumroad で：<!-- link: gumroad -->

ローカルの AI で安全にコーディングする方法は、Zenn の本にまとめています：https://zenn.dev/shacikku3/books/local-ai-coding

## ライセンス

MIT © 2026 shachilab。[LICENSE](LICENSE) を見てください。
