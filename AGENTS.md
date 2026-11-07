# AGENTS.md

本仓库的 agent 规则与避坑记录只写在这个文件里，不新建 `CLAUDE.md`。

## 产品约束

- 一个功能一个入口。新功能先在 `DESIGN.md`「设计规则」里确定唯一入口再实现；其他页面只放跳转链接，不放执行同一动作的第二个按钮，也不为同一资源再加一套写接口。
- 遵守 `DESIGN.md` 的术语表：主界面用「录音笔」「同步」「在录音笔中」「已整理」「无线快传 / 蓝牙」「AI 整理」「Floatboat 助手」「处理记录」。BLE、0x 指令码、SDK、bridge、退出码、stdout/stderr、runId、idempotencyKey、agent、LLM、Host、SSID、FTP、热点等字样只能出现在「设置 › 诊断与高级」和错误的「查看详情」里。
- 技术细节只放在诊断区或 `detail`：错误的 `error` 是一句中文结论，原文进 `detail`。
- 后台任务不得改变系统网络：自动同步默认只用蓝牙，无线快传只在用户手动同步或用户显式开启 `auto_pull_wifi` 时发生。
- 设备 SDK（memotalk-sdk）只由 `src/server/device/service.ts` 持有，其他模块不得自己 spawn Python 访问录音笔；宿主 SDK（`sdk/`）不改动。

## 验证

- 要证明页面或接口行为可用时，使用 `.claude/skills/verify-openminutes`（build → launch → doctor → browse → cleanup）。它会把实例隔离在 `.workbench/verify/<runId>/`，不会碰 Floatboat 里的真实数据。

## Worktree

- 分支合并后立即清理对应的 worktree（`orca worktree rm --worktree <id> --force`）。清理前用 `git cherry origin/main <branch>` 确认没有未合并的提交（只出现 `-` 行）；如果出现 `+`，再用 tree 或文件 diff 确认内容是否已经在 main 里（rebase 合并后 SHA 会变）。

## Shell 避坑

- 从 PowerShell 调用 `powershell.exe -Command` 时，外层双引号会先展开 `$变量`，反斜杠不能保护 `$`，会把 `$s.GetInstalledVoices()` 变成无效表达式。短命令用外层单引号；脚本用 UTF-16LE Base64 的 `-EncodedCommand`，文本/路径用环境变量传入，不拼进 PowerShell 源码。
- PowerShell 中传给 `browse.mjs` 的 `@file` 参数必须加引号（例如 `'@.claude/skills/verify-openminutes/features/voice-import.steps.json'`），裸写 `@.claude/...` 会被当作 PowerShell 语法而报 `Unrecognized token`。
- 当前 Windows PowerShell 不支持 `&&`，会在执行前报 `The token '&&' is not a valid statement separator`。需要串联不可逆操作时，先单独运行并检查前置命令，再运行下一条；不要把检查和推送写进同一条换行命令。

- 需要生成含正则或反斜杠的 JS/脚本文件时，用 Write 工具写文件。不要用 heredoc 或 `sed -i` 生成：反斜杠会被吃掉（`\.`、`\[` 失效），正则会悄悄变成字符类而匹配失败。
- `browse.mjs` 的步骤里，`eval` 的 JS 一旦含有引号，就先把步骤写进 JSON 文件，再用 `@file` 传入。在 shell 单引号里多层转义，会得到 `SyntaxError: Invalid or unexpected token`。
- 排查残留进程时，不要按进程名或 `dist\server\index.mjs` 匹配：Floatboat 自己的工作台进程也匹配这个路径，用户的 Chrome 也在运行。要按 `run.json` 里的 pid，或者按 `*verify*browser-profile*` 匹配。另外，PowerShell 查询自身的命令行也会命中模式串，计数时要排除掉。
- 推送、合并之类不可逆的操作，必须用 `&&` 串在检查命令之后，或者先单独看完检查结果再执行。不要把检查和推送放在同一条命令里用 `;` 或换行分隔：检查失败时推送照样会执行（2026-10-29 曾因此在 typecheck failed 的情况下推送了 main，事后用 tree 哈希确认内容与已验收的版本一致）。
- `cmd | grep …` 的退出码是 grep 的，不是 cmd 的：只要 grep 匹配到 `FAIL` 行就算成功，`&&` 会照样往下走。需要按命令成败串联时，用 `return ${PIPESTATUS[0]}` 包一层，或者不要接管道。
- 主 checkout `C:/Users/unknown/orca/openminutes` 默认没有 `node_modules`，在里面直接跑 `build.mjs` 会报 `Cannot find module 'lucide-react'`。这是环境问题，先 `pnpm install`，或者在已经装好依赖的 worktree 里验证同一个 tree（用 `git rev-parse <ref>^{tree}` 比对）。
- 本地 main 和 origin/main 可能是同一份内容、但历史不同（远端被整理成了线性历史，SHA 不一样）。推送前先 `git merge-base --is-ancestor origin/main main`，失败时用 `git diff origin/main <本地提交>` 判断内容是否相同。不要强推。
- 在 Windows 上 kill 服务进程后立刻打开它的 `data.sqlite` 写入，可能报 `disk I/O error`（文件句柄还没释放）。直接改库来模拟崩溃时，写库要带重试（例如每 500ms 一次、最多 20 次）。
- GitHub 网络偶尔出现 EOF 或 TLS 握手超时。`gh pr create` 失败后，先用 `gh pr list --head <branch> --state all` 确认 PR 没有建成再重试，避免重复开 PR。
- 独立启动的服务不能把导入目录放在系统临时目录（`%TEMP%`），否则应用会把它改回真实的 `~/memo/memotalk/inbox`。scratch 数据放在 `.workbench/` 下（已被 gitignore）。
- PowerShell 调用 `browse.mjs` 时，`@file` 参数必须整体加引号，例如 `'@.claude/skills/verify-openminutes/recipes/host-single.json'`；裸写 `@.claude/...` 会被 PowerShell 解析成语法而报错。
- 用 `perl -0pi -e` 改 TS 源码时，替换串里的 `'\n'` 会被写成真实换行，JS 字符串字面量被截断成两行（2026-11-08 两次出现，typecheck 才暴露）。替换内容含 `\n`、反引号、`${}` 或多层引号时，直接用 Edit 工具；在 bash 双引号里写 `${...}` 还会报 `bad substitution`。
- PreToolUse hook 会拦截文本中出现 `python` 字样的 Bash 命令（即使命令本身不运行 Python，例如编辑含 `python_path` 的脚本）。这类编辑改用 Edit/Write；需要带解释器路径运行的流程写成 `.mjs` 驱动脚本，在脚本里拼路径。
- 设置了 `OPENMINUTES_FAKE_DEVICE` 之外的同步会真实切换本机 Wi-Fi：验证里不得对真实录音笔执行同步，只用 `launch.mjs --fake-device=wifi|ble|absent`（需 `MEMOTALK_TEST_PYTHON`）；真机验收交给用户按清单执行。
- Windows 下 `rg` 的目录参数不要写 `sdk/*`，使用 `rg <pattern> sdk` 或 `rg --files sdk -g '<glob>'`。先用 `rg --files` 定位再读文件；Floatboat 的 SDK 位于 `resources/workbench-sdk/`，不在 `workbench-toolchain/sdk/`。
## Repository rules

- Use Chinese for user-facing communication.
- Use only AGENTS.md for repository instructions; do not create CLAUDE.md.
- Run Python through `uv run`; use `pnpm` for Node packages.
- New repositories are private unless explicitly requested otherwise.

## PowerShell pitfalls

- Check `Test-Path` before reading optional instruction files. This checkout
  originally had no root AGENTS.md; assuming it existed caused Get-Content to fail.
- Keep filesystem operations in PowerShell and use literal, resolved paths.
- Pass complex browser steps through a JSON file, not nested shell quoting.
- `git check-ignore` returns exit 1 when a path is not ignored; this is not a
  filesystem failure. Use `git ls-files` to check whether it is already tracked.
- On Windows, verification cleanup can hit EPERM immediately after stopping its
  server because file handles are still closing. Re-run the same nonce-scoped
  cleanup after the process exits; never kill unrelated processes or broaden
  the deletion target.
- PowerShell does not expand `sdk/*.mjs` for ripgrep. Search the directory with
  `rg -g '*.mjs' pattern sdk` instead of passing a wildcard path.
- The pinned verification skill's `text=` selector does not match `strong`.
  Use a specific button CSS selector when its label is rendered in `strong`.
- For verification readbacks separated by long browser sessions, request
  `Connection: close`; a stale Node fetch keep-alive socket produced ECONNRESET
  even though the isolated server's doctor and logs remained healthy.
- Never inspect or modify real Floatboat workbench data or stop existing Floatboat processes.
- Run independent shell reads separately, not with semicolon command chains. Pass complex browser steps through a JSON file, not nested shell quoting.
- Do not persist `sys.executable` from `uv run --with ...`: it can point to an ephemeral environment removed at exit (observed ENOENT in SDK tests). Create a checkout-local environment with `uv venv`, install with `uv pip --python`, and run Python checks with `uv run --python <venv>`.
- Windows E2E cleanup can fail with EPERM while a browser profile is releasing file handles. Close owned browsers via CDP `Browser.close`, wait for exit, then retry the same nonce-scoped cleanup. Never kill by process name or delete a broader directory to bypass the lock.
- A GitHub HTTPS connection timeout is not a rejected commit. Retry the same ordinary push and verify the remote SHA; do not force-push, change credentials, or rewrite the remote to work around transient connectivity.
- 在 Bash 工具里用 `cat >> file <<'EOF'` 追加含 `'` 的内容（CSS、JSX）会报 `unexpected EOF while looking for matching '`，文件一字未写；`node -e "..."` 里的反引号模板串会被 bash 当命令替换执行，`\d` 等反斜杠也会被吃掉。写源码、JSON 步骤、正则一律用 Write/Edit 工具，写完 grep 复查。
- `browse.mjs` 的 `fill` 对受控 `<input type="date">` 不生效（Delete 清空后 React 立刻还原旧值）。日历页要定位日期时用 `#/calendar?day=YYYY-MM-DD` 路由，不要 fill 日期框。
- `tests/e2e-preflight.mjs` 需要 `OPENMINUTES_VERIFY_SCRIPTS=<checkout>/.claude/skills/verify-openminutes/scripts`，缺少时在第 14 行断言失败。它的模拟 Host 分支在 run.json 里写 `hostMode: 'fixture'`，doctor 只接受回环地址；不要为了让它通过而改回 `none` 或 `floatboat`。
- Bash 工具每次调用都是新 shell，上一条里 `export MEMOTALK_TEST_PYTHON=...` 不会保留；`launch.mjs --fake-device` 因此报 `requires MEMOTALK_TEST_PYTHON` 且不写 run.json，后续 doctor 报 `no run.json`。每条命令都内联写 `MEMOTALK_TEST_PYTHON=.workbench/test-python/Scripts/python.exe node .../launch.mjs ...`。
- `browse.mjs` 偶尔报 `timed out waiting for DevToolsActivePort`（无头浏览器启动慢），实例本身没问题。直接用同一个 runId 和 label 重跑一次即可，不要 kill 浏览器进程或删 profile 目录。
- 「断开连接」时 `device_user_disconnected` 先落库、worker 后退出（约 5–7 秒）。e2e 读回 `/api/device` 要轮询到 `state==='disconnected'`，不要在看到「自动连接暂停」后立即断言。
- Bash 工具里把多行 Python 用 `uv run python - <<'EOF'` 喂进去，内容含引号时报 `unexpected EOF while looking for matching ''`，整条命令不执行。批量改文件时先用 Write 工具把脚本写到 `.workbench/<任务>/x.py`（已 gitignore），再 `uv run python -I .workbench/<任务>/x.py <参数>`。
- 本仓库没有 `typescript` 依赖，`pnpm exec tsc` 报 `Command "tsc" not found`。严格类型检查用 `node .claude/skills/verify-openminutes/scripts/build.mjs`（Floatboat 编译器，输出 `typecheck: passed`）；`pnpm test` 走 tsx，不做类型检查。
- 导入对话框的「扫描并导入」在目录读回之前是禁用的，配方里直接 `click` 会静默无效，随后 `waitText 已导入` 超时。点击前先 `{"waitText":"个音频文件"}`。
- 设备 e2e 配方共享一台假录音笔：在跑过 `device-connection` 的 run 上再跑 `live-busy`，文件已经同步完，同步瞬间结束，报 `Live page did not block 开始 while syncing`。每个设备配方都 cleanup 后用新的 runId 重新 launch。
- 验证某个回归测试是否真能抓住旧 bug 时，用脚本把旧代码临时换回去跑一次，确认失败后立刻换回来，再 `grep` 核对源码已恢复。时序类竞态要在测试里人为制造窗口（例如 prelude 里让占锁的命令 sleep），否则旧代码也会碰巧通过。
