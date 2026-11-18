# 深色主题配色重做（Anthropic × Gruvbox）

## Intent

MusePi 客户端的深色模式「文字看不清」。目标：让深色模式在**所有**深色主题预设下达到 WCAG AA 正文对比度（≥ 4.5:1），同时保留浅色主题现状（用户反馈浅色主题好看，不动），并让默认深色主题成为一套结合 Anthropic 中性暖灰与 Gruvbox 暖奶油质感的新配色。

## 根因（实测，非推测）

问题不在「深色」本身，而在 **3 天前 commit `24353459` 引入的扁平亮度下限**：

```css
/* tokens.css — 所有深色预设共用 */
--fg-muted: 0.70   --fg-faint: 0.60
```

对比度取决于**文字与它自己那一层底色**的组合，但这个下限是按默认深色底（`--bg` L=0.145）算的。移植深色预设的底色浅近一倍（Gruvbox L=0.277、Anthropic L=0.268、Catppuccin L=0.243），同一份文字亮度就掉到 4.5:1 以下。

实测最低对比度（WCAG，正文对四层表面 `--bg` / `--bg-raised` / `--bg-inset` / `--bg-overlay` 取最小）：

| 预设 | 底 L | 最低对比度 | 最差组合 |
|---|---|---|---|
| default (:root) | 0.145 | **5.45** ✅ | faint/overlay |
| graphite | 0.158 | 4.26 | faint/overlay |
| midnight | 0.165 | 4.17 | faint/overlay |
| openchamber | 0.172 | 4.54 ✅ | — |
| tokyonight | 0.180 | 3.50 | faint/overlay |
| ayu | 0.188 | 3.32 | faint/overlay |
| vesper | 0.196 | 3.25 | faint/overlay |
| aura | 0.196 | 3.25 | faint/overlay |
| dracula | 0.200 | 3.21 | faint/overlay |
| solarized | 0.216 | 3.13 | faint/overlay |
| kanagawa | 0.243 | 3.58 | faint/raised |
| catppuccin | 0.243 | 2.86 | faint/overlay |
| nord | 0.244 | 2.67 | faint/overlay |
| monokai | 0.248 | 2.69 | faint/overlay |
| anthro | 0.268 | 3.44 | faint/raised |
| gruvbox | 0.277 | 2.59 | faint/overlay |

**15 个深色预设里 14 个不达标**，默认深色是唯一合格的。

第二个放大器：`--bg-overlay`（浮层/菜单底）比 `--bg-raised` 亮很多（多数预设 +0.03~0.10 L），而 `--bg-overlay` 上的 `--fg-faint` 几乎在每个预设都是最差组合。

浅色主题实测全部 AA（default fg 14.96:1、muted 6.87:1、faint 5.78:1），**不动**。

## Goals

- 15 个深色预设的「文字 × 四层表面」最低对比度全部 ≥ 4.5:1。
- 默认深色主题换成 Anthropic 中性暖灰底 + Gruvbox 暖奶油字的新配色，成为新的品牌默认深色。
- 每个预设的文字亮度**由该预设自己的底色推导**，不再共用一个常量下限。
- 浅色主题视觉与数值完全不变。
- 品牌金 `#d9a441` 不动（被 logo 渐变、TUI 主题 `theme/defaults/musepi.json`、HTML 导出 `export/html/web-palette.ts` 共用）。

## Non-goals

- 不改浅色主题的任何 token。
- 不改 accent 轴的预设集合（brand / mono / ocean / jade / theme / custom）与自定义 accent 推导逻辑。
- 不重做终端 xterm ANSI 调色板（独立问题，见「已知遗留」）。
- 不改 `packages/stats` 的独立配色（独立页面，独立 token 体系）。
- 不引入新的运行时 JS 依赖去做对比度计算（用脚本离线校验）。

## Approaches

### 1. 每预设独立推导文字亮度（**选定**）

对每个深色预设，按它自己的四层表面亮度，用脚本求解 `--fg` / `--fg-muted` / `--fg-faint` 的最小 OKLCH 明度 L（保持各自 hue / chroma），使四层表面上都 ≥ 4.5:1。写回 tokens.css 的每个深色预设块。

- 优点：逐预设精确达标；保留每个主题的色相个性；一次性根治，不再靠全局下限拍脑袋。
- 代价：要重算 15 个预设 × 3 个 token 的数值；部分预设需明显提亮文字。

### 2. 统一压暗所有深色预设的底色

把每个移植深色预设的 `--bg` 压到接近 L=0.145，靠统一的文字亮度达标。

- 优点：改动集中，文字数值不用动。
- 代价：**破坏主题辨识度**——Gruvbox 的深灰、Nord 的蓝灰、Catppuccin 的紫底会被拉平成同一片近黑，等于把 13 个预设变成 1 个。与「保留移植主题」相悖。

### 3. 压暗 `--bg-overlay` + 提高 faint 下限

只动 overlay 层和 faint 亮度。

- 优点：改动最小。
- 代价：只治 overlay 一个组合，`faint/raised`、`faint/bg` 在 Anthro / Kanagawa 等预设仍然不达标；治标不治本。

**选定 1**，并在其之上叠加 3 的 overlay 收敛（见「Key changes」第 2 条）。

## Key changes

### 1. `packages/client-core/src/styles/tokens.css` — 15 个深色预设的文字阶梯重算

每个 `[data-theme="dark"][data-ui-theme="…"]` 块重写 `--fg` / `--fg-muted` / `--fg-faint`：
- hue 与 chroma 保留预设自己的（不破坏主题色相个性）。
- L 由该预设最亮的表面（通常是 `--bg-overlay`）反解，保证四层表面上都 ≥ 4.5:1。
- 三级阶梯保持可见差异（fg > muted > faint），faint 仍比 muted 低一档。

**`--fg` 的特例**：`solarized` 当前 fg L=0.6979 比 muted L=0.70 还低——本就是笔误（前景比次级文字还暗）。重算时 fg 强制 ≥ muted + 0.05。

**已求解的最终值**（脚本反解，hue/chroma 保留各预设自己的）：

| 预设 | overlay L（旧→新） | fg | muted | faint | 最低 |
|---|---|---|---|---|---|
| midnight | 0.240 → 0.240 | 0.92 0.014 265 | 0.700 0.014 265 | 0.619 0.013 265 | 4.50 |
| graphite | 0.232 → 0.227 | 0.93 0.006 90 | 0.720 0.008 90 | 0.611 0.008 90 | 4.51 |
| openchamber | 0.124 → 0.124 | 0.824 0.0158 90.3 | 0.700 0.0154 88.7 | 0.600 0.0091 80.7 | 4.54 |
| catppuccin | 0.351 → 0.324 | 0.879 0.0426 272.3 | 0.700 0.0315 272.9 | 0.690 0.0307 278.1 | 4.51 |
| nord | 0.367 → 0.296 | 0.933 0.0104 261.8 | 0.700 0.0195 264.4 | 0.664 0.0207 267.6 | 4.51 |
| tokyonight | 0.296 → 0.243 | 0.846 0.0611 274.8 | 0.700 0.0529 274.8 | 0.622 0.0366 276.7 | 4.50 |
| anthro | 0.230 → 0.230 | 0.979 0.0041 91.4 | 0.721 0.0071 106.6 | 0.668 0.0062 106.6 | 4.50 |
| aura | 0.317 → 0.278 | 0.944 0.0029 308.4 | 0.700 0.0097 17.4 | 0.649 0.0082 340.7 | 4.52 |
| ayu | 0.311 → 0.275 | 0.887 0.0093 258.3 | 0.700 0.0148 251.6 | 0.646 0.0142 252.2 | 4.52 |
| dracula | 0.320 → 0.244 | 0.978 0.0079 106.5 | 0.700 0.0455 281.9 | 0.623 0.0334 280.4 | 4.51 |
| gruvbox | 0.375 → 0.313 | 0.894 0.0566 89.2 | 0.700 0.0287 76.6 | 0.680 0.0149 75.2 | 4.51 |
| kanagawa | 0.212 → 0.212 | 0.876 0.0391 99.1 | 0.700 0.0088 106.6 | 0.658 0.0016 286.3 | 4.51 |
| monokai | 0.366 → 0.292 | 0.978 0.0079 106.5 | 0.700 0.0044 106.5 | 0.660 0.008 115.9 | 4.51 |
| solarized | 0.326 → 0.293 | 0.750 0.0159 196.8 | 0.700 0.0063 211 | 0.662 0.0225 213.7 | 4.51 |
| vesper | 0.317 → 0.286 | 0.924 0.0033 17.2 | 0.700 0 89.9 | 0.655 0 89.9 | 4.51 |

注意 `solarized` 的 fg 从 0.698 提到 0.750——修掉了「前景比次级文字还暗」的笔误。

### 2. `--bg-overlay` 向 `--bg-raised` 收敛

现状 overlay 比 raised 亮 0.03~0.10 L，浮层里的次级文字对比度最差。解法：把深色预设的 overlay 收到 `raised + 0.035 L` 以内（overlay 作为**更靠上**的浮层应当更亮，但亮多少由「文字仍达标」反推，而不是拍脑袋）。上表已给出每个预设的收敛后数值——收敛幅度最大的几个是 nord（-0.071）、dracula（-0.076）、gruvbox（-0.062）、tokyonight（-0.053），因为它们的 overlay 原本比卡片亮太多。

### 3. 默认深色（`:root`）换新配色 — Anthropic 中性暖灰底 + Gruvbox 暖奶油字

实测五个候选，全部 AA 通过（保留品牌金 `#d9a441` 不变）：

| 候选 | 底 / 卡片 / 嵌入 / 浮层 | 正文 / 次级 / 弱 | 最低对比度 | 特点 |
|---|---|---|---|---|
| A | `#100f0d` `#191816` `#090807` `#23221e` | `#ede7db` `#bfbaaf` `#a29e95` | **5.99** | Anthropic 中性暖灰底 + Gruvbox 奶油字，底接近纯黑 |
| B | `#0b0a08` `#14120f` `#060504` `#1d1a16` | `#ede7d9` `#c0baae` `#a29e95` | **6.48** | A 再压深一档，最接近 Gruvbox bg0 深度 |
| C | `#11100f` `#1a1917` `#090908` `#242320` | `#efede6` `#bcbab4` `#a09e9a` | **5.90** | 保留 Anthropic 完全中性的字（无黄味），底带暖 |
| D | `#262624` `#2f2e2c` `#1f1f1d` `#363532` | `#ede7db` `#bfbaaf` `#a29e95` | **4.57** | Anthropic **原版表面** + Gruvbox 奶油字 |
| F | `#181816` `#21201e` `#131311` `#282825` | `#eee9dc` `#c1bcb0` `#a3a097` | **5.65** | Anthropic 表面压深一档 + Gruvbox 奶油字 |

（对应 OKLCH：底 `oklch(0.17 0.004 95)` 一族，奶油字 `oklch(0.93 0.018 88)` 一族。）

- **A**：Anthropic 的中性暖灰结构 + Gruvbox 的奶油文字。底 #100f0d 接近纯黑但带暖意，文字 #ede7db 是暖白而非纯白。最低 5.99:1。
- **B**：底更深一档（#0b0a08），最接近 Gruvbox 原版 bg0 的深度感，文字最亮，最低 6.48:1。
- **C**：保留 Anthropic 完全中性的字（无黄味），只让底带暖。最低 5.90:1。
- **D**：直接沿用 Anthropic 官方深色表面（#262624 / #2f2e2c / #1f1f1d），只把文字换成 Gruvbox 奶油色。改动最小、最贴近 Anthropic 官方观感，但底偏亮（比现状默认深色浅一截），最低 4.57:1，余量最小。
- **F**：Anthropic 表面整体压深一档 + Gruvbox 奶油字。介于 A 与 D 之间。

**推荐 F**：它是「深色就该够深」与「Anthropic 的暖中性质感」的折中——底 #181816 既有 Anthropic 的暖灰质地，又比现状默认深色（#0c0907）只亮一点点、绝不显灰；文字用 Gruvbox 奶油白（#eee9dc）带一点暖，和品牌金同源；最低 5.65:1 留足余量，浮层里的弱文字也稳。

**由用户在对比页上选**（见「待定」）。

### 4. 新增对比度回归测试


`apps/desktop/test/theme-contrast.test.ts`：解析 tokens.css 的每个深色预设，断言四个文字 token 在四层表面上都 ≥ 4.5:1。用仓库已有的 chroma-js（已是 client-core 依赖，`deriveCustomAccent` 在用）做 oklch→对比度换算，不引入新依赖。

现有的 `apps/desktop/test/theme-palette.test.ts` **不需要修改**——它断言的是主题轴结构（每个预设都有 `--theme-hue`、玻璃层是派生的、follow-theme accent 是默认值），没有任何一条依赖那个全局亮度下限。本次的下限是 CSS 里的注释约定，不是测试断言，所以新增对比度测试即可，旧的断言继续有效。

### 5. 文档同步

- `docs/gui-design.md` + `docs/gui-design.zh-CN.md`：深色主题的对比度契约改写为「按预设底色推导」，并记录实测表。
- `packages/coding-agent/CHANGELOG.musepi.md` 的 `[Unreleased]` 加条目，附英文译文。

## 已知遗留（本次不修，需单独决策）

1. **终端 xterm ANSI 调色板**：`apps/desktop/src/components/TerminalPanel.tsx` 的 `xtermTheme()` 是硬编码 hex，不跟随主题预设。深色下 `brightBlack: #76706c` 在 Gruvbox 底上对比度偏低。属独立问题。
2. **`packages/stats` 页面**：`packages/stats/src/client/styles.css` 是独立 token 体系（`--dim: oklch(0.53 0.018 307)`），未纳入本次审计。

## Verification

1. `bun test apps/desktop/test/theme-contrast.test.ts` —— 新增的对比度回归测试（15 个深色预设全绿）。
2. `bun test apps/desktop/test/theme-palette.test.ts` —— 现有主题契约测试（不受本次改动影响，验证主题轴结构未被破坏）。
3. `bun run check:ts` —— 仓库类型与脚本检查（含 `check-css-tokens` / `check-css-structure` / `check-radius-tokens`）。
4. **视觉验证**：用 `.agent-tmp/dark-theme-compare.html` 对比页渲染改后的真实 token 值，逐屏确认正文 / meta / 时间戳 / 代码块 / 浮层菜单 / accent 按钮的观感；并用桌面端实机截图确认（几何验证 ≠ 视觉可见，这是本仓库 GUI 文档的既有要求）。
5. 对比度数字由离线脚本给出（`.agent-tmp/` 下的计算脚本），最终以测试内的断言为回归依据。

## 待定（需要用户拍板）

1. **默认深色配色选 A / B / C / D / F**（见 Key changes 3）。五个全部 AA 通过，差别在底色深浅与文字暖度。推荐 **F**。
2. **移植深色预设是否也整体微调底色**，还是只按 Approach 1 提亮文字（保留移植主题的原底色）。前者更统一，后者更忠实于原主题。设计文档当前按「保留原底色 + 收敛 overlay + 提亮文字」写，解出的数值表即此方案。
