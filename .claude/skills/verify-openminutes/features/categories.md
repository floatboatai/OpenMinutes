# 分类管理

用户在分类页新建自定义分类（名称、颜色、说明），可以在列表里就地改名、改颜色，也可以删除自定义分类，删除后其中的录音会回到未分类。七个内置分类可以改名、改色，但不能删除。

## Sub-features

- `cat-list`：「全部分类」卡片列出内置分类（会议纪要、客户访谈、灵感想法、待办事项、课程学习、私人生活、未分类）和自定义分类，每行显示录音条数。内置分类的行显示「内置」，没有删除按钮。
- `cat-create`：「新增分类」卡片填写名称（最多 12 字）、选择颜色、填写说明，点「创建分类」后提示「分类已创建」。名称为空时按钮不可点。
- `cat-rename`：在「<名称> 的名称」输入框里改名，失焦后保存，提示「分类已更新」。
- `cat-recolor`：「<名称> 的颜色」取色器，修改后提示「分类已更新」。
- `cat-delete`：自定义分类行的「删除」会弹出确认框，确认后提示「分类已删除」。
- `cat-in-detail`：新建的分类会出现在详情页「整理」栏的分类下拉框，以及录音库的「按分类筛选」里。

## How to get to it (user POV)

- 侧边导航「分类」，或直接访问 `#/categories`。

## Driving it with browse.mjs

Preconditions:

- 满足基线条件。录音不是必需的。

- **列表与内置项。** 运行 `browse.mjs <runId> cat '[{"goto":"#/categories"},{"waitText":"全部分类"},{"waitFor":"aria=会议纪要 的名称"},{"expectText":"内置"},{"screenshot":"01-list.png"},{"aria":"01-list.aria.txt"}]'`。
- **新建。** 在同一次调用里追加 `{"fill":"input[placeholder=\"例如：产品评审\"]","value":"验证分类"},{"fill":"input[placeholder=\"这类录音通常在什么场景下产生\"]","value":"verify run"},{"click":"text=创建分类"},{"waitText":"分类已创建"},{"waitFor":"aria=验证分类 的名称"},{"screenshot":"02-created.png"}`。读回验证：`curl -s "$URL/api/categories" | tee $E/cat/after-create.json` 中应包含「验证分类」，并且 `isSystem` 为 false。
- **改名。** 追加 `{"fill":"aria=验证分类 的名称","value":"验证分类2"},{"press":"Tab"},{"waitText":"分类已更新"}`。读回验证：接口返回的名称应为「验证分类2」。
- **删除。** 追加 `{"goto":"#/categories"},{"waitFor":"aria=验证分类2 的名称"},{"eval":"(() => { const row = document.querySelector('[aria-label=\"验证分类2 的名称\"]').closest('li'); row.querySelector('button').click(); return true; })()"},{"waitText":"分类已删除"},{"screenshot":"03-deleted.png"}`。`steps.log` 里应记录 `dialog confirm: 删除分类「验证分类2」？… -> accepted`，之后接口里不应再有这个分类。
- **内置不可删（接口）。** 运行 `curl -s -X DELETE "$URL/api/categories/1"`。预期返回 `ok:false`，错误码为 `SYSTEM_CATEGORY`。

## Gotchas

- 分类名显示在就地改名的 `<input>` 里，不属于可见文本，所以 `expectText:"会议纪要"` 会失败。要用 `waitFor:"aria=会议纪要 的名称"`。
- 新增表单的输入框没有 aria-label，只能用 placeholder 作为 CSS 选择器来定位。
- 改名在失焦（blur）时才保存。必须 `press Tab` 或点击别处，单纯 fill 不会触发保存。
- 列表里每一行都有「删除」按钮。`text=删除` 会命中第一个可见的那个，可能删错分类，所以要像上面那样先定位到行，再点该行的按钮。
- 名称输入框的 aria-label 是用加载时的名称生成的。改名后，要等页面刷新（toast 出现后重新 `goto`），新的 aria-label 才会生效。
