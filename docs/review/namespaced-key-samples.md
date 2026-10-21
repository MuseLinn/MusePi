# 命名空间 key 命名示范（settings 域，60 条）

## 规范（吸收 openchamber）

```
<域>.<功能区/分组>.<元素>[.<细节>]
```

| 段位 | 含义 | 例 |
|---|---|---|
| 1 | 域（词典文件） | `settings.` |
| 2 | 设置分组（schema 的 `ui.group`） | `display.` |
| 3 | 元素（短而描述性的标识符） | `hideToolActivity` |
| 4 | 细节/变体 | `field` / `aria` / `info` / `desc` |

**硬性约束**（从 openchamber 实测得出）：

- 平均长度 40 字符、平均 4.5 段、上限 56 字符
- 元素段用 camelCase，短句取 2–4 个词，**不把整句 slug 化**
- 变体后缀固定用词：`field`（控件标签）/ `info`（说明）/ `aria`（无障碍）/ `desc`（较长描述）/ `placeholder` / `empty`
- 占位符**不进 key**，靠值里的 `{name}` 表达

---

## 示范：`settings` 域 60 条

### Display 分组（19 条中取 8）

| 现 key（英文原文） | 命名空间 key |
|---|---|
| `Shimmer` | `settings.display.shimmer.field` |
| `Streaming rendering` | `settings.display.smoothStreaming.field` |
| `Reveal assistant text and streamed tool input smoothly while chunks arrive` | `settings.display.smoothStreaming.info` |
| `Hide Tool Activity` | `settings.display.hideToolActivity.field` |
| `Hide model-initiated tool calls and results from the transcript` | `settings.display.hideToolActivity.info` |
| `Show Token Usage` | `settings.display.showTokenUsage.field` |
| `Running Turn Detail` | `settings.display.liveActivityRows.field` |
| `How much of a RUNNING turn to keep in view. 'Show all' (default) streams every row; …` | `settings.display.liveActivityRows.info` |

### Display 分组 —— 选项值（5 条）

| 现 key | 命名空间 key |
|---|---|
| `Show all` | `settings.display.liveActivityRows.option.all` |
| `Every row stays visible while the agent works.` | `settings.display.liveActivityRows.option.allInfo` |
| `Latest 3 rows` | `settings.display.liveActivityRows.option.latest3` |
| `Latest 5 rows` | `settings.display.liveActivityRows.option.latest5` |
| `Latest 7 rows` | `settings.display.liveActivityRows.option.latest7` |

**规则**：选项值统一挂在 `.option.<value>` 下，`<value>` 用 schema 的枚举值本身（`all` / `latest3`），不是英文。这样 `settings.set` 的值与 key 对齐，一眼能对应。

### Status Line 分组（7 条）

| 现 key | 命名空间 key |
|---|---|
| `Status Line Preset` | `settings.statusLine.preset.field` |
| `Status Line Separator` | `settings.statusLine.separator.field` |
| `Context-Reactive Line` | `settings.statusLine.contextLine.field` |
| `Session Accent` | `settings.statusLine.sessionAccent.field` |
| `Transparent Status Line` | `settings.statusLine.transparent.field` |
| `Compact Thinking Level` | `settings.statusLine.compactThinkingLevel.field` |
| `Show Hook Status` | `settings.statusLine.showHookStatus.field` |

**注意**：这里第 3 段直接用了 **schema 的 key 尾段**（`statusLine.preset` → `preset`）。这是最强的锚定 —— 设置键与文案键同形，改名时一起改。

### Vision / Images（10 条）

| 现 key | 命名空间 key |
|---|---|
| `Serve Images as URLs` | `settings.vision.urls.enabled.field` |
| `Image URL Backends` | `settings.vision.urls.backends.field` |
| `Image Upload Command` | `settings.vision.urls.options.field` |
| `Image URL Public Base` | `settings.vision.urls.publicBaseUrl.field` |
| `Image URL Lifetime (hours)` | `settings.vision.urls.ttlHours.field` |
| `Image URL Bind Host` | `settings.vision.urls.bindHost.field` |
| `Image URL SSH Target` | `settings.vision.urls.sshTarget.field` |
| `Image URL SSH Remote Port` | `settings.vision.urls.sshRemotePort.field` |
| `Auto-Resize Images` | `settings.images.autoResize.field` |
| `Block Images` | `settings.images.blockImages.field` |

### Thinking / Loop Guard（6 条）

| 现 key | 命名空间 key |
|---|---|
| `Loop Guard` | `settings.thinking.loopGuard.enabled.field` |
| `Loop Guard Scan Prose` | `settings.thinking.loopGuard.checkAssistantContent.field` |
| `Loop Guard Tool-Call Reminder` | `settings.thinking.loopGuard.toolCallReminder.field` |
| `Tool-Call Loop Guard` | `settings.thinking.toolCallLoopGuard.enabled.field` |
| `Tool-Call Loop Threshold` | `settings.thinking.toolCallLoopGuard.threshold.field` |
| `Tool-Call Loop Exempt Tools` | `settings.thinking.toolCallLoopGuard.exemptTools.field` |

### Advisor / Prewalk / Git（6 条）

| 现 key | 命名空间 key |
|---|---|
| `Enable Advisor` | `settings.advisor.enabled.field` |
| `Advisor Sync Backlog` | `settings.advisor.syncBacklog.field` |
| `Advisor Immune Turns` | `settings.advisor.immuneTurns.field` |
| `Enable Prewalk` | `settings.prewalk.enabled.field` |
| `Enable Git Integration` | `settings.git.enabled.field` |
| `Max In-Flight Requests` | `settings.services.maxInFlightRequests.field` |

### Output Limits（5 条）

| 现 key | 命名空间 key |
|---|---|
| `Artifact Spill Threshold (KB)` | `settings.outputLimits.spillThreshold.field` |
| `Artifact Tail Size (KB)` | `settings.outputLimits.tailBytes.field` |
| `Artifact Head Size (KB)` | `settings.outputLimits.headBytes.field` |
| `Output Column Cap` | `settings.outputLimits.maxColumns.field` |
| `Artifact Tail Lines` | `settings.outputLimits.tailLines.field` |

### Theme / Composer / Terminal（5 条）

| 现 key | 命名空间 key |
|---|---|
| `Dark Theme` | `settings.theme.dark.field` |
| `Light Theme` | `settings.theme.light.field` |
| `Composer Shape` | `settings.composer.shape.field` |
| `Terminal Provider` | `settings.terminal.provider.field` |
| `Additional Workspace Dirs` | `settings.workspace.additionalDirectories.field` |

---

## 这套规范能解决什么

| 问题 | 解决 |
|---|---|
| 改文案不用改 key | ✅ `field` 后缀恒定，文案在值里 |
| 大小写漂移 | ✅ key 是标识符，不受文案影响 |
| 同句英文多语境 | ✅ `.field` / `.info` / `.desc` 区分 |
| 选项值与设置键对应 | ✅ `.option.<enumValue>` |
| 设置键与文案键同形 | ✅ 第 3 段直接取 schema key 尾段 |

## 需要你确认的两点

**1. 难度集中在长句描述**

`settings` 域 2873 键里，约 **40% 是长句描述**（`info` / `desc`）。这些的命名必须理解语义，是纯人工判断。60 条示范里我处理了 8 条长句，耗时占比最高。

**2. `.field` 后缀是否要**

openchamber 用 `.field` 区分"控件标签"和同组其他文案：

```
settings.openchamber.tools.field.agentControlToolSummary
```

我认为值得保留 —— 它让"这是控件标签"这个事实进到 key 里。但它会让每个 key 多 6 字符。如果你的偏好是更短（`settings.display.shimmer`），我可以去掉。
