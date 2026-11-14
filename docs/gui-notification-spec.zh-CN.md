---
layout: default
title: 应用内通知契约
status: living
summary: MusePi 应用内通知栈的 API、存活时长、位置、堆叠交互与可访问性规范。
scope:
  - packages/client-core
  - apps/desktop
lang: zh-CN
---

# 应用内通知规范

[English](gui-notification-spec.md) | 中文

状态：现行契约。实现位于 `packages/client-core/src/lib/action-toast.ts`（store）、`apps/desktop/src/components/ActionToast.tsx`（桌面视图）与 `packages/client-core/src/components/shell/Toasts.tsx`（guest/mobile 视图）。

## 1. 这个表面负责什么

应用内通知栈是所有"短暂、由应用主动发起"的反馈的唯一归属：动作结果、撤销提示、会话级 daemon 通知，以及不属于连接横幅的错误。

它不负责：

- OTA 更新卡（`UpdateToast` / `UpdateDialog`）——与桌面右下角共用锚点列，但状态独立；
- 系统通知（`apps/desktop/src/lib/notify.ts`，设置 → 通知与音效）；
- 常驻通知中心或历史记录。通知离开后即消失。

## 2. API

store 不依赖 React，也不依赖 i18n。视图负责计时器；store 负责 `expiresAt`、替换与容量。

| 导出 | 契约 |
| --- | --- |
| `pushActionToast(input): number` | 新增一条。相同 `dedupeKey` 替换该来源的旧内容，返回 id。 |
| `dismissActionToast(id)` | 按 id 移除；未知 id 是静默 no-op。 |
| `dismissActionToastSource(dedupeKey)` | 只移除某个已恢复来源的通知。 |
| `pauseActionToast(id)` / `resumeActionToast(id)` | 冻结并续算剩余时长；幂等。 |
| `getToasts()` / `subscribeActionToasts(fn)` | 读取不可变列表 / 订阅变化。 |
| `ttlFor(kind)` | 某种类型的存活时长。 |

`ActionToastInput` 字段：`kind`、`message`，可选 `title`、`details`、`dedupeKey`、`actionLabel` + `onAction`、`cancelLabel` + `onCancel`。

kind 只决定前置图标与染色，玻璃底色保持中性：

- `info`——中性提示（信息图标，弱化色）；
- `success`——动作完成（对勾，成功色）；
- `warning`——需要处理的条件（警示图标，图标与描边用警告色）；
- `error`——失败，持续显示直到手动关闭（错误色，assertive 播报）。

| Kind | 存活时长 |
| --- | --- |
| `info`、`success` | 6000 ms |
| `warning` | 8000 ms |
| `error` | 永不过期 |

容量为 3。第四条通知先驱逐最旧的临时通知；持续错误只在整栈都是错误时才会被驱逐。

## 3. 入口

- **直接调用**——任意面板调用 `pushActionToast`；两个 shell 共用同一个 store。
- **`musepi-gui-toast`**——`window` 上的 `CustomEvent`。`detail` 可以是字符串，或 `ActionToastInput` 形状的对象；缺省 `kind` 为 `error`，保留旧错误横幅的语义。
- **扩展**——编译插件把 `lib/action-toast` 绑定到 `window.MusePiHostModules["action-toast"]`，插件与宿主共享同一份列表。
- **daemon 会话事件**——桌面会话 store 经 `apps/desktop/src/lib/session-notice.ts` 映射：

| 事件 | 结果 |
| --- | --- |
| `notice` | 按事件级别生成通知；`dedupeKey = session:notice:<source \|\| daemon>` |
| `auto_retry_start` | `info`，`session:retry` |
| `auto_retry_end` 成功 | 关闭 `session:retry` |
| `auto_retry_end` 失败 | `error`，`session:retry` |
| `auto_compaction_start` | `info`，`session:compaction` |
| `auto_compaction_end` skipped | 关闭 `session:compaction` |
| `auto_compaction_end` 中止 / 失败 / 完成 | `info` 或 `error`，`session:compaction` |

重试与压缩复用同一个来源键，因此栈里显示的是最新一步，而不是不断堆叠的进度行。

## 4. 位置与堆叠交互

**桌面**：`.gui-toast-corner` 固定在右下角（20 px 内缩，z 910），同时承载 `UpdateToast` 与 `ActionToastStack`；OTA 卡在该列内有自己的层级。

**guest/mobile**：`.sh-toasts` 是底部条（fixed，z 60，右对齐，最大 320 px）。

桌面栈行为：

- **折叠**：两条及以上时，只有最新一条完整可读；旧行裁成 10 px 细条并降低透明度。最新一条带 `gui-action-toast--front`。
- **展开**：指针进入或键盘聚焦时展开为正常的 8 px 间距列；离开后重新折叠。单条通知始终展开。
- **焦点可达**：折叠的同级通知仍保留按钮的 Tab 顺序；聚焦任一控件会先展开栈，再让下一次 Tab 落到下一条。
- **退场**：用户主动关闭、点动作、点取消时，行继续挂载 180 ms 并带 `gui-action-toast--closing`（淡出 + 下移 6 px）。来源恢复直接移除，不播退场。
- **倒计时环**：关闭钮带 16 px 环，按剩余时长走完。悬停或聚焦冻结，恢复后从冻结处继续。错误没有环。
- **取消**：`cancelLabel` 渲染为主操作前的次要文字按钮，先执行 `onCancel`，再关闭。

动效为入场 200 ms、退场 180 ms。`.gui-motion-off` 与 `prefers-reduced-motion: reduce` 会关闭入场、退场、倒计时环和折叠过渡。

## 5. 可访问性

- 错误在行上使用 `role="alert"` + `aria-live="assertive"`。
- 栈容器是 polite live region（`role="status"`、`aria-live="polite"`、`aria-atomic="false"`），且空栈时也保持挂载，因此第一条状态通知也能被播报。非错误行自身不带 role。
- 关闭钮有本地化的 `aria-label`/`title`；动作与取消都是真实 `<button>`。
- 悬停或焦点会暂停整栈所有可见计时器（而不只是指针下的一行），离开后各自续算剩余时间。栈不会抢占焦点。
- 折叠行仍然可达；展开只改变视觉，不改变 `aria-hidden`。

## 6. 边界

- 不做滑动关闭、RTL 镜像、移动端横幅布局或通知历史。应用没有 RTL 语言，桌面指针也不是滑动表面。
- OTA `UpdateToast` 不属于这个 store：它有自己的进度/重启状态与"复活"逻辑。
- 系统通知及其模板仍留在 `notify.ts` 与设置 → 通知与音效。
