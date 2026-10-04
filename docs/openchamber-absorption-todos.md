# openchamber 吸收待办：设计与实施清单

参考实现：`../openchamber`（只读参考检出，`git checkout --detach origin/main`）。
**本文档是工作文档，不是长期规格**：逐项吸收/关闭后应整体删除，不配对 `.zh-CN.md`
（同 `zcode-absorption-todos.md` 的约定）。某项转成长期能力后，把设计搬进
`docs/gui-design.md` / `docs/gui-implementation.md`，再从本文移除。

## 基线

| 项       | 值                                                                                                                                                                              |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 参考版本 | **v2.1.0**（`fc012ae00`，2026-10-01）；上次 pin 为 v1.22.0，跨 1.23 / 1.24 / 2.0                                                                                                |
| 工具链   | **仍是 Bun**：`bun@1.4.2`、唯一 `bun.lock`、Bun workspaces、`oven/bun:1.4.2`                                                                                                    |
| 新增     | `patchedDependencies` + `bun-patches/`（可抄，我们已同为 1.4.2）                                                                                                                |
| 变化     | **biome 被彻底删除** → `oxlint@1.78.0` + `eslint@9` + `typescript-eslint`。**我们不迁移**（全仓 biome + formatter 是格式契约的一部分），仅抄 `lint:anti-slop` / `deslop` 的思路 |
| 包结构   | 新增独立 `vscode` 与 `mobile` 包；11 语言 i18n docs 站（含 `zh-cn`）                                                                                                            |

## 工具链真相（先读，省时间）

- **`edit` 工具会把 tab 缩进文件整体压平成空格**（实测 `ChatView.tsx` `tab=2554 → 0`）。
  大文件用 `edit` 后必须看 `git diff --stat`；否则改用字节级精确替换。
- **biome 只检查相对 `main` 有改动的文件**，所以遗留文件的缩进债平时不报、一改就炸。
  详见 `gui-implementation.md` §45.5。
- **CSS 不在 biome 的 `files.includes` 里**，别把 `.css` 喂给 biome。

## 已落地（本批，2026-10-02）

见 `gui-implementation.md` §45 / `gui-design.md` §5x：⌘F 会话内查找、归档撤销 toast、
命令面板增量（Reload UI / 粘贴 session id 精确命中 / 记住 query）。

## 核查（2026-10-04，代码为唯一真相）

18 条逐项读码：**16 条完全未动，3 条部分落地**（下表标「部分」的三条）。除上面那批已落地项外没有别的存量收口——不要按梯队顺序推断"第一梯队做了一半"，第一梯队实际也只有零星几处沾边。

| #   | 项                                | 结论     | 关键锚点 / 差距                                                                                                                                                 |
| --- | --------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 可折叠 Markdown 段落              | 未动     | `Markdown.tsx:61-70` `html({text})` 一律 escape，`<details>` 永不产出                                                                                           |
| 2   | `/btw` 补齐                       | 未动     | 两半都缺：`BtwFloatingCard.tsx:69-98` 无 model/effort 入参、卡内无选择器；`SelectionToolbar.tsx:130-136` 无 /btw 入口                                           |
| 3   | 复制单条消息链接                  | 未动     | `main.cjs` 无协议注册（`second-instance` 只 restore+focus）；`musepi://` 仅在移动壳接 Capacitor                                                                 |
| 4   | 失败详情 + 复制为 Markdown        | 未动     | `Transcript.tsx:842-860` retry_failure 只有 chip+message；`:441-457` 单一 `ClipboardItem` 隐式附带 markdown                                                     |
| 5   | ⌘[ / ⌘] 会话前进后退              | 未动     | `lib/back-stack.ts` 仍只有 Android 硬件返回栈；命名冲突提醒有效                                                                                                 |
| 6   | per-agent 固定标签色              | 未动     | `tool-render/tools/task.tsx:446,541` → `punkAvatarUri(id)` 仍按 identity 哈希                                                                                   |
| 7   | 可搜索主题选择器                  | **部分** | 主题预设已从 `Segmented` 换成 `GuiSelect`（不再是硬塞 10 项的 Segmented），但 `GuiSelect.tsx:60-82` 只有 ↑↓/Enter，**无输入框、无 query 过滤**                  |
| 8   | 命令面板 query 过滤               | **部分** | 分组标题已有（`CommandPalette.tsx:318,337,359`），但 `:319` `actions.map` 与 `:338` `panels.map` **仍无过滤**；query 只驱动 session 搜索与 exact-id             |
| 9   | git 按 hunk 暂存/丢弃             | 未动     | `git.stage` = `git add -- <paths>`（`server.ts:2516-2540`），无 `git.apply`/`git.discard`/hunk 参数；`git-panel.tsx` 只传 `{paths}`                             |
| 10  | 后台任务实时日志 + detach         | 未动     | `ContextPanel.tsx:1514-1540` 5s 轮询 + 只有 cancel；无流式日志、无 detach RPC                                                                                   |
| 11  | 文件预览 audio/video/字体/mermaid | 未动     | `FilePane.tsx:74-97` `PreviewState` 九态不含这四类；mermaid 只在 Markdown 里渲染                                                                                |
| 12  | 悬浮磨砂 composer + 羽化          | 未动     | 布局模型未动：composer 仍是 flex 兄弟（`ChatView.tsx:2741-2775`），`--chat-composer-inset`/`data-live-tail` 全仓零命中                                          |
| 13  | 引用悬浮面板                      | 未动     | `quote-cards.tsx` 仍 27 行、`quotes: string[]`、12px X；发出时仍拍平成 `> ` 纯文本                                                                              |
| 14  | 滚动条交互打磨 5 点               | 未动     | 5 点全零改动：`FloatingScrollbar.tsx:184,187` 热路径仍每帧读布局、`:89-96` 单 last-scrolled 实例、无程序化滚动抑制、`:217-221` pacman 无比例 thumb 且只支持垂直 |
| 15  | 「In work」会话分区               | 未动     | 侧栏仍只有 pinned/projects/archived/cron，无第四轴                                                                                                              |
| 16  | 每会话三态权限 + 盾牌             | **部分** | 三态胶囊与盾牌已存在（`composer/approval-mode-button.tsx:22,108`），但读写的是**全局** `tools.approvalMode`，注释自承 "no per-session state involved"           |
| 17  | multi-run                         | 未动     | 全仓零命中，daemon 无对应 RPC                                                                                                                                   |
| 18  | 主题导入                          | 未动     | `tmTheme`/`vscode-theme` 全仓零命中；zip 导入模式仅 `scrollbar-skins.ts:101`                                                                                    |

## 别抄 —— 我们已经更强

| 能力          | 对方                          | 我们                                                                                              |
| ------------- | ----------------------------- | ------------------------------------------------------------------------------------------------- |
| Turn stats    | 工作状态面板                  | `composer/stats-pills.tsx` 更细（模型/工具耗时、avg TTFT、tok/s、cache 命中率）+ `TrajectoryView` |
| Activity 折叠 | 折叠成工具+文件摘要           | `round-collapse.ts` 已做，另带「探索了代码库」分段与 `+N/−N`                                      |
| 侧栏状态图标  | 运行/后台/未读                | `STATUS_COLOR` + working 脉冲 + 未读排序                                                          |
| Timeline 视图 | Grouped ↔ Timeline            | `SessionSidebar.tsx` 已有，另多 groups / archived                                                 |
| 扩展贡献面板  | SDK `service.surface`         | `collab-proto/extension-slots.ts` 契约更严，连 `transcript.node` 都有                             |
| 用量统计      | 柱状图面板                    | `settings-sections/usage.tsx` 已细分到 per-model / per-folder / per-agent-type                    |
| 滚动条        | per-container 浮层 + 原生混用 | **我们领先**：全局浮层轨零抖动 + 皮肤导入；对方至今**没有** always-show 开关                      |

## 待办（按投入产出排序）

### 第一梯队 · 小改动高感知

1. **可折叠 Markdown 段落** — 流式过程中即可开合。落点：
   `client-core/src/components/transcript/Markdown.tsx`（完全没处理 `<details>`）。
   与已落地的 activity 折叠可叠加。
2. **`/btw` 补齐** — `BtwFloatingCard.tsx` 已有独立草稿/历史/停止/分支，只差两件：
   自己的 model+effort 选择器（现在吃会话当前模型）、以及**选中文本工具栏入口**
   （`SelectionToolbar.tsx` 目前只有 quote/ask/copy）。
3. **复制单条消息链接** — 铸 `musepi://session/<sid>/message/<mid>`。**前置已就绪**：
   走 `requestJump`（见 §45.2）。真正工作量在 Electron 注册协议处理器。
   顺带补「粘贴 session id 精确查找」的侧栏入口（面板侧本批已做）。
4. **失败回复的「Show response details」** — 展开 provider 原始响应。我们只给了笼统错误，
   而 provider 401/限流的原文只出现在右侧用量面板。操作行另加显式的「复制为 Markdown」
   （现在 markdown 是 `ClipboardItem` 隐式带的，用户无法只要 markdown）。
5. **⌘[ / ⌘] 会话前进后退** — ⚠️ `client-core/src/lib/back-stack.ts` 已被 Android 硬件返回
   占用，新加别重名。
6. **per-agent 固定标签色** — 现在 `avatar-presets` 是按 identity 哈希的随机美术，不是分配的
   颜色。一张 hue 表即可。
7. **可搜索主题选择器**（导入部分见第三梯队）— 现状是 10 个硬编码预设塞在一个 `Segmented`
   控件里（`appearance.tsx:228`），无搜索。

### 第二梯队 · 要动 daemon / 渲染核心

8. **命令面板继续升级** — 分组标题、词首匹配、已打开文件优先。⚠️ 面板当前**完全不按 query
   过滤 actions**（本批只加了 exact-id 与 Reload UI，这条仍未修）。
9. **Git 按 hunk 暂存/取消暂存/丢弃** — 我们只到文件级（`git-panel.tsx:391`），
   需新增 `git.apply` RPC。
10. **后台任务实时日志 + 「把运行中的步骤送去后台」** — `JobsPane` 有状态行和取消，
    但没有流式日志，也没有 detach 动作。
11. **文件预览补齐** — audio / video / 字体 / mermaid 作为**文件**预览
    （mermaid 目前只在 markdown 里渲染）。现有 `PreviewState`（`FilePane.tsx:74`）已覆盖
    文本/md/html/图片/PDF/docx/xlsx。

### 第三梯队 · 概念而非 UI（产品价值最高）

12. **悬浮磨砂 composer + 内容羽化** — 最大的一项，**必须独立 PR**。差的是**布局模型**不是特效：
    - 对方：滚动容器 `absolute inset-0` 铺满整列，composer 是 `absolute bottom-0` 浮在上面，
      列表尾部有 `flex-shrink-0` spacer，高 `calc(var(--chat-composer-inset) + clearance + gap)`，
      inset 由 `ResizeObserver` 写 CSS 变量。羽化是**纯静态 CSS mask**（全仓库零
      `animation-timeline`），精髓在 `data-live-tail`：流式时把羽化带末端收到
      `100% − composerHeight`，让正在生成的那行在上边缘刚好完全透明、不被切一半；静止时末端
      延伸回容器底部，行就滑进玻璃下面。
    - 我们：composer 是 flex 兄弟节点（`ChatView.tsx` 两处），滚动区在它上方就结束了，
      内容**根本不可能**走到 composer 后面。所以要改的是布局模型。
    - 顺带：他们的权限卡是 `absolute bottom-full` **浮在** composer 上方（不推走它），但把实测
      高度写进 clearance 变量同时撑大尾部 spacer 与 mask 末端 —— 我们的 `gui-approval-wrap`
      是**在流内**的，每次审批都挤压一次 transcript。
13. **引用悬浮面板** — 我们差得最远。`composer/quote-cards.tsx` 总共 27 行：
    `quotes: string[]`、唯一操作是 12px 的 X、在流内、不透明背景 + 重阴影 + 4 行 clamp，
    发出去还会被拍平成 `> ` 前缀纯文本。对方 `ComposerContextChips.tsx` 470 行。
    按感知收益排：① N 张卡片收成一个浮动面板（现在 3 条引用就把 transcript 顶高 100px）
    → ② 玻璃 + 轻阴影 → ③ 可滚动 + 按实测算 max-height → ④ 每条编号标题 → ⑤ 总数徽标
    → ⑥ 每条编辑 + 在 transcript 里定位原文。
14. **滚动条交互打磨** — 5 个具体可借鉴点：① hover 是一等输入（我们只在真实滚动后才出现，
    靠近长设置页毫无提示）② 滚动热路径零布局读取（我们每帧跑 `getComputedStyle` +
    `getBoundingClientRect`）③ per-container 实例（我们只有一个 last-scrolled 记忆，两个
    滚动区会闪）④ 程序化滚动抑制（我们每次 smooth scrollTo 都重绘并拉伸 gummy，像橡皮筋）
    ⑤ pacman 皮肤没有按比例的 thumb，且只支持垂直轴。
15. **「In work」会话分区** — 不是按项目/时间，而是「我正在改东西」的活跃桶：开始真活自动进、
    看起来完成打灰勾、手动标记完成才移出。我们只有 projects/groups/archived，这是**正交的
    第四个轴**。
16. **每会话三态权限模式（ask / safety net / accept all）+ composer 盾牌** — 我们权限链很深
    （18 级），但是否已收成这一个可一眼看清的可视锚点**待确认**。
17. **多模型并发跑同一 prompt（multi-run）** — 侧栏占一行、结果对比页、保留其一或合并。
    能力性新增。
18. **主题导入** — VS Code 主题 / `.tmTheme` 导入 + 单色变体选择。好消息：
    `lib/scrollbar-skins.ts` 已有成熟的 zip 导入模式可参照。

### 建议降级

- **per-device 设置分账** — 对方 web/desktop/mobile/vscode 共用一套 UI 才需要；我们是
  Capacitor 独立构建，收益低。
- **VS Code 扩展包** — 技术上前置都在（共享组件 `client-core` + daemon 的 WebSocket 协议，
  形状和他们用的 opencode server 一样），但对方每个版本都有 `## App` / `## VS Code` 两套
  平行段落，功能逐条对应 —— 这是**一整套 UI 双倍维护**，而且是分发策略，只有核心 GUI 够强了
  才回本。真要做就做廉价 80% 版：**薄扩展 + webview 内嵌现有 web UI** 指向 daemon，
  一个包、零 UI 重复。先记着，别现在做。

## 运维习惯（可抄）

- **`patchedDependencies` + `bun-patches/`** — 版本已对齐，可直接用。
- **`knip`（`dead-code`）+ `react-doctor` + `deslop`** — 尤其 `scripts/anti-slop.mjs`：
  他们写了个脚本检测自家 UI 里的 AI-slop 模式。我们 `AGENTS.md` 的 prose 标准极重，
  这思路对得上。旁证：他们明明有 knip，`@heroui/scroll-shadow` 仍是死依赖（源码零 import，
  `index.css:304` 注释自称是它的 fallback）—— 死依赖治理也会漏。
- **启动/动画/切换性能剖析脚本**（`profile:startup` / `profile:animation` / `profile:switch`）。
