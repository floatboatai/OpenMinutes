# 录音位置列与打开所在文件夹

录音列表在「录音」和「分类」之间有一列「位置」：在录音笔中的录音显示「录音笔」；本机的录音显示「本机」和所在文件夹（~ 简写，过长时保留末尾，悬停 title 是完整路径）；没有音频文件时显示「—」。点本机位置会打开该文件所在的文件夹。这是此功能的唯一入口（接口 `POST /api/recordings/:id/reveal`，只接受录音 id）。

打开方式由「设置 › 通用 › 打开录音所在文件夹」决定：「在 Floatboat 中打开」（默认）或「在 Windows 资源管理器中打开」。Floatboat 打开失败时提示「可以在设置中改为用 Windows 资源管理器打开」，不会自动改用资源管理器。860px 以下收起位置列。

## 测试开关

`launch.mjs` 给每个隔离实例都设置 `OPENMINUTES_FAKE_REVEAL=<证据目录>/reveal.log`：服务端只把要执行的调用追加到这个文件（每行一个 JSON），**不弹资源管理器，也不在用户的 Floatboat 里开标签页**。不要在没有这个变量的实例上点位置列。

## Driving it with browse.mjs

```bash
node .claude/skills/verify-openminutes/scripts/launch.mjs <runId> --no-host
ffmpeg -hide_banner -loglevel error -f lavfi -i "sine=frequency=440:duration=6" -ar 16000 -ac 1 -b:a 32k ".workbench/verify/<runId>/inbox/REC20261029_101500.mp3"
node .claude/skills/verify-openminutes/scripts/browse.mjs <runId> library-location '@.claude/skills/verify-openminutes/features/library-location.steps.json'
cat .workbench/verify-evidence/<runId>/reveal.log
```

步骤：导入 → 断言表头顺序「录音 / 位置 / 分类」、位置显示「本机」且文件夹以 `2026-10` 结尾 → 点位置（默认模式）出现「已在 Floatboat 中打开」→ 设置里改成资源管理器并保存、读回 `open_folder_with=explorer` → 再点位置出现「已在资源管理器中打开」→ 不存在的录音返回 `NOT_FOUND`。

副作用读回：`reveal.log` 应有两行：

- `{"mode":"floatboat","url":"file:///…/library/2026-10"}`
- `{"mode":"explorer","command":"explorer.exe","args":["/select,","…\\library\\2026-10\\REC20261029_101500.mp3"]}`

## 未覆盖

- 「录音笔」显示需要假录音笔（`--fake-device`，需 `MEMOTALK_TEST_PYTHON`）；由 `tests/reveal.test.ts` 覆盖。
- Floatboat 打开失败的提示与 Host 参数（工作区选择、file:// URL）由 `tests/reveal.test.ts` 的假 Host 覆盖。
- Floatboat 是否真能在标签页里显示 file:// 目录，需要用户在真机上确认。
