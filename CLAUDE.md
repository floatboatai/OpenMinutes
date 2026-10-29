# CLAUDE.md

## 验证

- 要证明页面或接口行为可用时，使用 `.claude/skills/verify-openminutes`（build → launch → doctor → browse → cleanup）。它会把实例隔离在 `.workbench/verify/<runId>/`，不会碰 Floatboat 里的真实数据。

## Shell 避坑

- 需要生成含正则或反斜杠的 JS/脚本文件时，用 Write 工具写文件。不要用 heredoc 或 `sed -i` 生成：反斜杠会被吃掉（`\.`、`\[` 失效），正则会悄悄变成字符类而匹配失败。
- `browse.mjs` 的步骤里，`eval` 的 JS 一旦含有引号，就先把步骤写进 JSON 文件，再用 `@file` 传入。在 shell 单引号里多层转义，会得到 `SyntaxError: Invalid or unexpected token`。
- 排查残留进程时，不要按进程名或 `dist\server\index.mjs` 匹配：Floatboat 自己的工作台进程也匹配这个路径，用户的 Chrome 也在运行。要按 `run.json` 里的 pid，或者按 `*verify*browser-profile*` 匹配。另外，PowerShell 查询自身的命令行也会命中模式串，计数时要排除掉。
- 推送、合并之类不可逆的操作，必须用 `&&` 串在检查命令之后，或者先单独看完检查结果再执行。不要把检查和推送放在同一条命令里用 `;` 或换行分隔：检查失败时推送照样会执行（2026-10-29 曾因此在 typecheck failed 的情况下推送了 main，事后用 tree 哈希确认内容与已验收的版本一致）。
- `cmd | grep …` 的退出码是 grep 的，不是 cmd 的：只要 grep 匹配到 `FAIL` 行就算成功，`&&` 会照样往下走。需要按命令成败串联时，用 `return ${PIPESTATUS[0]}` 包一层，或者不要接管道。
- 主 checkout `C:/Users/unknown/orca/openminutes` 默认没有 `node_modules`，在里面直接跑 `build.mjs` 会报 `Cannot find module 'lucide-react'`。这是环境问题，先 `pnpm install`，或者在已经装好依赖的 worktree 里验证同一个 tree（用 `git rev-parse <ref>^{tree}` 比对）。
- 本地 main 和 origin/main 可能是同一份内容、但历史不同（远端被整理成了线性历史，SHA 不一样）。推送前先 `git merge-base --is-ancestor origin/main main`，失败时用 `git diff origin/main <本地提交>` 判断内容是否相同。不要强推。
- 独立启动的服务不能把导入目录放在系统临时目录（`%TEMP%`），否则应用会把它改回真实的 `~/memo/memotalk/inbox`。scratch 数据放在 `.workbench/` 下（已被 gitignore）。
