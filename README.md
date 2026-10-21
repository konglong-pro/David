# David

David 是一个零生产依赖的 Chrome Manifest V3 扩展。0.6.0 增加可自定义的浏览器快捷键；继续支持 0.5.0 的富内容 `.babel.json` 归档、Markdown 复制与 `.md` 下载。

## 操作

点击工具栏的 David 图标，使用英文弹窗：

- **Export for Babel**（`B`）：导出包含图片资产、Markdown 和原排版静态快照的 `.babel.json` 文件；优先使用页面选区，否则使用当前已加载的完整 AI 对话。
- **Quick Copy**（`C`）：优先复制页面文字选区；没有选区时，复制当前受支持 AI 页面的已加载对话。
- **Select Messages**（`S`）：点击起始和结束消息，选择单条或连续区间；支持反向选择。面板中的 **Export for Babel** 导出当前范围的富内容归档；**Copy** / `Enter` 复制 Markdown，**Save Markdown** 保存 `.md`。**Select all** 全选，**Start over** 重选，`Escape` / **Cancel** 退出。
- **Save Markdown**（`D`）：与 Quick Copy 使用相同的选区优先规则，下载 UTF-8 `.md` 文件。文件名取自页面标题，去除不适合文件名的字符。

弹窗支持 `Tab` / `Enter` 操作。页面提示“download started”表示浏览器已接收下载；具体保存位置和确认弹窗由 Chrome 下载设置决定。

完整对话支持 `https://chatgpt.com`、`https://chat.openai.com`、`https://gemini.google.com`、`https://claude.ai`。网页选区支持普通 HTTP/HTTPS 页面。不支持任意、不相邻的消息组合。

ChatGPT 同时识别旧版角色节点和新版用户气泡、回答正文节点。0.4.1 修复新版页面显示 “No ChatGPT conversation was found on this page.” 的问题，并保持消息顺序和范围选择；同一轮的提问与回答分别识别，页面工具栏和标记为排除复制的内容不会混入正文。

## 快捷键

Chrome 获得焦点时可以直接运行四个动作，无需先打开 David 弹窗：

| 动作 | Windows / Linux / ChromeOS 默认建议 | macOS 默认建议 | 弹窗内按键 |
| --- | --- | --- | --- |
| Quick Copy | `Alt+Shift+Q` | `Control+Shift+Q` | `C` |
| Select Messages | `Alt+Shift+S` | `Control+Shift+S` | `S` |
| Save Markdown | `Alt+Shift+D` | `Control+Shift+D` | `D` |
| Export for Babel | `Alt+Shift+E` | `Control+Shift+E` | `B` |

macOS 的 `Control` 指物理 Control 键。默认使用 Q（Quick）和 E（Export），避开当前 Chromium 已使用的 `Alt+Shift+C` 和 `Alt+Shift+B`。弹窗仍使用熟悉的 C / S / D / B。

弹窗每个按钮下的 **Browser** 显示 Chrome API 返回的实际绑定，包括用户自定义的键；**Unassigned** 表示未分配，可能被用户清空或与浏览器、系统、其他扩展冲突。**Unavailable** 表示暂时无法读取绑定。点击 **Configure browser shortcuts**，或手动打开 `chrome://extensions/shortcuts`，即可检查和修改。升级扩展后 Chrome 也可能保留旧绑定，请以弹窗和该设置页为准。这些默认快捷键只在 Chrome 内生效，不注册系统全局快捷键。

消息选择面板打开时，原生 S 快捷键保留已选范围；原生复制、保存和归档快捷键操作当前消息范围，未选消息时明确提示。操作进行中忽略重复原生命令，避免重复下载或竞争。浏览器无法启动快捷键动作（例如页面受限、注入失败或未选消息）时，David 图标会显示红色 `!`，悬停可查看原因；下一次成功执行原生快捷键会清除提示。归档开始后的捕获或下载错误仍在源页面提示。

弹窗字母键和页面范围面板的 Enter / Escape 会避让输入框、可编辑内容、输入法组合和重复按键。明确配置的浏览器组合键仍表示主动运行 David，可以在输入框选中文字后执行复制或保存。

实现遵循 [Chrome Commands API](https://developer.chrome.com/docs/extensions/reference/api/commands)；默认键避让依据为 [Chromium 快捷键源码](https://raw.githubusercontent.com/chromium/chromium/main/chrome/browser/ui/accelerator_table.cc)。系统及浏览器保留键有优先权，因此无法保证所有平台和用户配置下均自动分配。

## 导入 Babel

1. 等待回答生成和图片加载完成，展开需要的折叠内容。在 David 选择 **Export for Babel**，或先选择消息范围再导出。
2. 在 Babel APP 选择目标文件夹，再选择 **Import → Import David archive**，打开下载的 `.babel.json`。
3. 检查标题、Markdown、图片数量、捕获提示和静态快照预览，再打开未保存草稿。设置文件夹、标签并保存后，图片进入该 APP 的托管附件，原排版作为不可变离线快照保存。

只需要文字时，使用 **Save Markdown**，再通过 **Import → Import Markdown file** 导入 `.md`。

使用 **Quick Copy** 或消息范围的 **Copy** 后，也可以在 Babel 选择目标文件夹，再选择 **Import → Paste Markdown / David**，从剪贴板读取并检查 Markdown，打开未保存草稿。也可以直接在新建笔记中粘贴。David 不会自动创建或保存 Babel 笔记。

Markdown 复制和 `.md` 下载按 UTF-8 字节计算，最多 **10 MiB（10,485,760 字节）**，与 Babel Markdown 文件导入上限一致。超限时会提示选择较小的消息范围，不截断内容。

## 富内容归档

- 可读的照片 URL 会按需读取并附带原始 PNG/JPEG/WebP/GIF 字节；也支持页面中已显示的 `blob:` / `data:` 图片。读不到原始像素时，会使用当前标签页截图保留其显示状态。
- SVG、Canvas 和显示中的嵌入视觉转成 PNG；含嵌图、外部引用、复杂效果的 SVG 使用截图，避免缺失其中的可见组成部分。图注保留在原位置并进入 Markdown。
- 静态 HTML 树保留普通文字、表格、代码、任务状态、颜色、边框、Flex/Grid 排版等。复杂 CSS 背景、伪元素和效果按需使用静态 PNG 保留显示外观，同时在 Markdown 中保留可编辑文字。字体文件不内嵌；没有被栅格化的自定义网页字体可能由本机字体替代，排版会尽量保留。
- 公式的 Markdown 仍使用显式 LaTeX；静态快照保留其显示外观。导出内容包含源页面 URL、标题和捕获时间；Markdown 本文仍不自动插入这些元数据。
- 截图时请保持源标签页为活动标签页，不要改变浏览器缩放。David 会按需滚动、裁剪和拼接当前视觉，完成或取消后恢复滚动位置；页面进度面板提供取消按钮，`Escape` 也可取消。
- 只选中图、公式或复杂布局的一部分时，如果无法在捕获中严格排除未选中内容，会明确拒绝该选区。请选中完整视觉或消息，或用 **Quick Copy** 复制选中的文字；不会扩大选区后悄悄保存。
- 表单、音频播放器等不可归档部分会提示遗漏。交互、脚本、动画逻辑和未展开/未加载内容不包含在静态快照中；图片未加载、容器裁剪无法完整捕获或超限时会提示，而不截断后悄悄保存。

格式固定为 `babel.web-archive` 第 1 版：单个 UTF-8 JSON，内含 `markdown`、Base64 光栅图片和受限静态节点树。Markdown 图片使用 `assets/<name>`，快照图片只引用归档内资产。Babel 校验后生成禁止脚本和联网的离线快照。

归档上限：Markdown 10 MiB、50 个资产、每个资产 10 MiB、解码图片总计 100 MiB、JSON 文件和展开后的快照 HTML 各 150 MiB、30,000 个快照节点、80 层深度。过大时选择更小的消息范围；不会静默截断。截图还有浏览器画布像素上限，过大视觉需缩小选区或先展开到可捕获大小。

## 格式契约

完整对话以 `## User`、`## Assistant` 分隔。正文标题向下移两级（最多六级），避免与角色标题混淆。网页文字选区不添加角色标题；正文不添加页面标题、来源、平台、URL、时间或其他元数据。

````md
## User

请解释这段代码。

## Assistant

```python
print("hello")
```

公式：\(x_1 + \frac{a}{b}\)。
````

- 保留标题、粗体、斜体、删除线、链接、代码块、嵌套列表、任务状态、引用和 GFM 表格。多位数有序列表的段落、嵌套列表和代码按实际列表标记宽度缩进。
- 普通页面文字中的 `$`、Markdown 标记和 HTML 标签按字面文字转义，避免在 Babel 被误识别为公式、文档链接或 HTML；已渲染的结构仍转换为相应 Markdown。文本框中的选区视作原始文本，保留其输入内容。
- 普通文字、图片图注和图片占位符中的字面方括号使用 `&#91;` / `&#93;`，避免与 Babel 的显式 LaTeX 块分隔符 `\[` / `\]` 冲突；链接和图片的 Markdown 结构方括号保持不变。
- 有 TeX 源码的已渲染公式使用显式 LaTeX 分隔符：行内 `\(...\)`，块级 `\[...\]`。多行公式使用块级分隔符。这样可与 Babel 的单美元 Typst 公式共存。只有 MathML 时尝试还原 TeX，复杂排版仍需检查。
- 表格单元换行使用 `<br>`；新版 Babel 只在表格单元内处理这一安全换行标记。表格中的公式使用行内 LaTeX。单元合并、复杂布局不能无损表示为 GFM 表格。
- Mermaid 保留为 `mermaid` 代码块；Babel 显示其源码。已转换为 SVG/Canvas 且没有源码的图表不会恢复为 Mermaid。
- 链接和图片 URL 使用带尖括号的 Markdown 目标，保留括号、查询参数和编码字符；链接仅接受 HTTP、HTTPS、mailto、tel，图片仅接受 HTTP/HTTPS。脚本等不支持的链接保留文字。

## Markdown 模式与共同限制

- **Quick Copy / Save Markdown** 的 HTTP/HTTPS 图片只保留 URL，不附带图片字节；链接可能需要登录、过期或无法离线读取。要保留图片请使用 **Export for Babel**。
- **Quick Copy / Save Markdown** 中 `blob:`、`data:` 或不可转换的图片使用 `[Image unavailable: 图注]` 占位文字。
- 上传文件只有在被选中的正文里存在可转换文字或普通链接时才能保留相应部分；不包含附件字节。图片和原始附件需要在 Babel 中另行添加。
- **Quick Copy / Save Markdown** 不会将 SVG、Canvas 或无源码图表转换成图片；富内容归档可保留它们显示中的静态外观。所有模式的长对话只包含当前分支、DOM 中已经加载的消息；导出前可先滚动到顶部加载旧消息。
- 各 AI 网站更新 DOM 后可能需要调整适配器。Claude 包含结构回退，但本地真实网站验证曾遇到 Cloudflare；合成页面测试不能替代真实账户页面确认。
- 快捷键通过 Chrome 的扩展快捷键页设置；目前没有其他设置页、右键菜单或系统全局快捷键。

所有转换在当前浏览器内完成，不上传给外部转换服务。**Export for Babel** 会按需请求当前所选内容的图片 URL，或使用现有 `activeTab` 授权截取当前标签页；浏览器跨域限制仍生效，不绕过鉴权。**Quick Copy / Save Markdown** 不发起这些图片请求。没有新增主机权限或 `downloads` 权限，不长期保存捕获内容；Blob 下载文件保留在用户选择的位置。

## 安装或更新

1. 打开 `chrome://extensions`，开启“开发者模式”。
2. 首次安装选择“加载已解压的扩展程序”，选择 `E:\David`；更新时点击 David 的“重新加载”。
3. 刷新需要导出的网页，建议将 David 固定到工具栏。

## 验证

Node 内置测试和脚本语法检查无需安装依赖：

```powershell
npm.cmd run check
```

有现成 Playwright 与 Chromium 环境时可运行真实 DOM 和下载集成检查（不增加生产依赖）：

```powershell
$env:DAVID_PLAYWRIGHT_MODULE = 'C:\path\to\node_modules\playwright'
$env:DAVID_CHROMIUM_PATH = 'C:\path\to\chrome.exe'
npm.cmd run test:browser
```

本地已能解析 `playwright` 且其 Chromium 已安装时，可省略这两个环境变量。浏览器检查只加载仓库中的合成会话并拦截外部请求，验证新版/旧版/混合 DOM、原有复制和下载、照片/SVG/Canvas/受限图片截图、复杂布局、归档下载、选区、消息范围、取消和滚动恢复。截图接口使用真实 Chromium 截图作为合成扩展后台桥，不访问真实账户。

快捷键检查还验证真实弹窗 DOM、自定义/未分配绑定显示、设置入口、范围复用、重复操作、输入框与 Shadow DOM 编辑、输入法组合防误触，并将扩展加载到临时 Chromium profile 检查真实 MV3 命令注册及弹窗绑定。自动化验证命令注册和路由行为；物理键盘、系统热键和用户 Chrome 配置的组合仍需在实际环境确认。

可选的 `DAVID_BABEL_CORE` 指向 Babel 的 `packages/platform/src/imports/web-archive-core.ts`，用于直接验证实际导出符合接收端合同。设置 `DAVID_ARCHIVE_FIXTURE_OUTPUT` 可将本次合成归档另存到指定位置。`tests/fixtures/captured-rich.babel.json` 是对应完整合成导出，`babel-conversation.md` 保留 Markdown 模式回归样例。

主要文件：`manifest.json` 配置最小权限，`background.js` 按需注入并校验/节流截图请求，`popup.*` 提供操作，`content.js` 负责适配及 Markdown，`archive.js` 负责富内容、静态树、图片和归档下载。
