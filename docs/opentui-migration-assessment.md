# OpenTUI 迁移可行性评估

> 用户提问：把 musepi TUI 换成 opencode 所用的 OpenTUI 是否可行？
> 评估基于 OpenTUI 官方文档（skill://opentui）与 musepi TUI 代码量/架构调研（2026-08-24）。

---

## 1. 结论先行

**可行，但代价极高（估算 4–8 周全职重写，高风险），当前不建议。** OpenTUI 是优秀的全屏 TUI 框架（opencode 生产验证），但它不是 drop-in 替代品——musepi 的 TUI 是约 **10 万行**深度集成的自研差分渲染体系，换引擎等于重写整个交互层，且会在终端边界情况（kitty/tmux/bracketed paste/ED3）上丢失多年打磨的经验。

**建议**：保持 musepi TUI。把 OpenTUI 记为「未来从零重写 TUI 时的候选引擎」，但不在现阶段投入。

---

## 2. 双方架构

### 2.1 musepi TUI（现状）

```
packages/tui/                        ~28K LOC  自研差分渲染 TUI 库
  editor.ts          多行编辑器：kill-ring、atoms、bracketed paste、
                     autocomplete、magic keywords、paste 芯片（刚移植）
  stdin-buffer.ts    bracketed paste 缓冲、OSC 5522、raw-paste 分类
  terminal.ts        ProcessTerminal：kitty 键盘协议、ED3 检测、鼠标
  markdown.ts        Markdown 渲染
  container/box      Component/Container 差分组件树
  image.ts           kitty 图形协议、图片渲染

packages/coding-agent/src/modes/     ~71K LOC  交互模式层
  interactive-mode.ts   5272 行   编排：transcript/状态栏/组件装配
  components/           30+ 组件  transcript、agent hub、选择器、
                                 queue/todo/thinking、chips band
  controllers/          input-controller（提交/粘贴/快捷命令）
```

关键特性（全部依赖自研 API）：
- **差分渲染**：组件树 diff → 增量帧，长会话滚动性能
- **编辑器**：atoms（`[Image #N]`/`[Paste #N]` 芯片 token + 原子删除）、kill-ring、bracketed paste 解码（tmux 重编码控制字节）、large-paste 菜单（刚移植）
- **滚动回退**：scrollback 快照、OSC 133 zone、ED3 风险终端重绘
- **kitty 图形**：图片内联、chips 缩略图
- **中文 UI**：zh-CN 标签、i18n

### 2.2 OpenTUI（目标）

```
Zig 原生核 + TS 绑定（@opentui/core），Bun-exclusive（Node 支持进行中）
  renderer.ts       CliRenderer：alternate-screen 全屏 / main-screen / split-footer
  components        Box/Text/Input/Textarea/Select/Markdown/Code/Diff
  layout            内置 Yoga flexbox
  keyboard          kitty 键盘协议、paste 事件、focus 路由
  scrollback        ScrollbackSurface + tree-sitter 高亮
  bindings          React / Solid
```

**优点**：
- 终端底层（输入解析、kitty 协议、渲染循环）由 Zig 核承担，正确性/性能有保障
- 组件化 + flexbox 布局，可定制性高
- React/Solid 绑定 → 复用 Web 组件模式
- opencode 生产验证（`alternate-screen` 全屏 TUI）

**缺点/风险**：
- **Bun-exclusive**（Node 支持 in-progress）——musepi 的 TUI 也在 Bun 上跑，无碍
- **无现成多行编辑器**：OpenTUI 只有 `Textarea`，没有 atoms/kill-ring/bracketed-paste 标记语义/autocomplete 菜单
- **滚动模型不同**：OpenTUI 的 scrollback surface 是「提交快照」模型；musepi 是「组件树 diff + 增量帧」，transcript 的即时更新/流式渲染语义需重写
- **无 widget 生态**：agent hub、queue、todo、thinking selector 等全部要自建

---

## 3. 差距分析

| 能力 | musepi TUI（现状） | OpenTUI | 迁移成本 |
|---|---|---|---|
| 多行编辑器（atoms/chips/kill-ring） | 完整（5K+ LOC，刚加 chips） | 仅 Textarea | **高**：需移植或重建编辑器 |
| Bracketed paste 解码（tmux 重编码等） | 完整（stdin-buffer + editor） | paste 事件 + decodePasteBytes | 中：事件有，语义要重建 |
| 差分渲染/滚动回退 | 完整 | 自有渲染器 + ScrollbackSurface | **高**：transcript 重写 |
| kitty 图形/图片内联 | 完整 | 未验证 | 中-高 |
| 组件树（Container/Box） | 完整 | 有（但 API 不同） | **高**：全部组件迁移 |
| 30+ 交互组件（hub/selector/queue…） | 完整 | 仅基础组件 | **高**：逐个重建 |
| 中文 i18n | 完整 | 布局无关 | 低 |
| daemon 模式（GUI 用） | 复用 modes 层 | 无对应 | 中 |

**总代码量**：`packages/tui`（28K）+ `modes`（71K）≈ 100K LOC。OpenTUI 只替代前者的渲染/输入底层，后者（交互逻辑）一个都不能省。

---

## 4. 关键风险

1. **终端边界情况回归**：tmux extended-keys 重编码、OSC 5522、ED3 快照重绘、kitty 键盘渐进增强——这些都是 musepi 踩坑数月积累的（见 learned lessons）。换引擎后全部要重新验证。
2. **编辑器语义**：atoms/chips（刚移植的 TUI 粘贴附件系统）依赖 `Editor` 的 atom 表、原子删除、getExpandedText 展开。OpenTUI Textarea 无此能力。
3. **transcript 流式渲染**：assistant 流式输出、tool call 展开、增量滚动——OpenTUI 的 scrollback surface 是「渲染后提交」模型，与 musepi 的「组件树持续 diff」不同，改造成本最高。
4. **Bun 版本锁定**：OpenTUI 需要特定 Bun 版本，musepi 可能需升级。
5. **生态年轻**：文档尚在完善（Node 支持未完成），踩坑无社区积累。

---

## 5. 结论与建议

- **结论**：迁移可行，但等价于「重写整个 TUI 交互层」——100K LOC 的 80% 都要动，4–8 周全职 + 高风险。
- **建议**：
  1. **保持现状**。继续在自研 TUI 上迭代（chips band、large-paste 菜单已吸收完毕）。
  2. **OpenTUI 记为未来候选**。若未来决定从零重写 TUI（例如统一 opencode 的交互模型），OpenTUI 是首选引擎——其 React 绑定可与 GUI 复用组件模式。
  3. **吸收 OpenTUI 的思路**（低成本）：其 split-footer 模式、scrollback surface 模型、kitty 渐进增强的参数组合，可在自研 TUI 中借鉴（部分已具备）。

---

## 6. 参考

- OpenTUI 文档：`~/.agents/skills/opentui/docs/`（getting-started / renderer / keyboard / react）
- opencode 生产使用：`harness-engineering/opencode/packages/`
- musepi TUI：`packages/tui/`（28K LOC）+ `packages/coding-agent/src/modes/`（71K LOC）