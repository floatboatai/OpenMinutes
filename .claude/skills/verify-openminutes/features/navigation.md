# 导航与单一入口

侧栏固定 6 项：录音、录音笔、实时字幕、日历、分类、设置。每页的 `<h1>` 与导航标签一致，当前页按钮带 `aria-current="page"`。详情页高亮「录音」，`#/settings/diagnostics` 高亮「设置」并自动展开「诊断与高级」。旧的 `#/overview` 和未知哈希都改写为 `#/library`。

## Sub-features

- `nav-six`：`nav[aria-label="主导航"] button` 恰好 6 个，顺序固定。
- `nav-current`：逐个点击后 hash、`aria-current` 和 h1 三者一致。
- `nav-rewrite`：`#/overview` 落到录音页；页面上不出现「概览」「导入新录音」。
- `nav-diagnostics`：`#/settings/diagnostics` 高亮「设置」并展开 `details#diagnostics`；从别的页面进 `#/settings` 时默认折叠。
- `nav-no-jargon`：录音笔页不出现 SDK、BLE、退出码、热点、SSID、读取清单、手动登记、导入目录；实时字幕页不出现 0x90、BLE。

## How to get to it (user POV)

- 打开应用即落在「录音」；左侧导航是唯一的页面切换方式，其他页面只放跳转链接。

## Driving it with browse.mjs

Preconditions：满足基线条件，普通启动（不需要 `--fake-device`），doctor 的 exit 为 0。

- 运行 `browse.mjs <runId> navigation @.claude/skills/verify-openminutes/features/navigation.steps.json`。
- 预期每个 `eval` 都返回值，最后一步返回 `"collapsed"`；`$E/navigation/console.log` 为空。

## Gotchas

- 导航按钮的 innerText 含徽标数字（例如「录音笔 3」），断言只读按钮里第一个 `span`。
- 同一个设置页从 `#/settings/diagnostics` 原地切到 `#/settings` 时保留展开状态，这是预期行为；验证默认折叠要先离开设置页。
