# TUI 扩展与自定义工具集成

[English](tui.md) | 中文

本文档介绍 `packages/coding-agent` 和 `packages/tui` 中扩展 UI、自定义工具 UI 与自定义渲染器所使用的**当前** TUI 契约。

## 此子系统是什么

运行时分为两层：

- **渲染引擎（`packages/tui`）**：差分终端渲染器、输入分发、焦点、覆盖层、光标定位。
- **集成层（`packages/coding-agent`）**：挂载扩展/自定义工具组件、绑定快捷键/主题，并恢复编辑器状态。

## 按模式的运行时行为

| 模式 | `ctx.ui.custom(...)` 可用性 | 备注 |
| --- | --- | --- |
| 交互式 TUI | 支持 | 组件挂载在编辑器区域或覆盖层中，获得焦点，且必须调用 `done(result)` 才能完成。 |
| 后台/无头模式 | 不可交互 | UI context 为空操作（`hasUI === false`）。 |
| RPC 模式 | 不挂载 | `custom()` 被实现为不支持的 UI，并返回 `undefined as never`；不要在 RPC handler 中依赖交互式 UI。 |

如果你的扩展/工具需要在非交互模式下运行，请使用 `ctx.hasUI` / `pi.hasUI` 做守卫。

## 核心组件契约（`@musepi/pi-tui`）

`packages/tui/src/tui.ts` 定义了：

```ts
export interface Component {
  render(width: number): readonly string[];
  handleInput?(data: string): void;
  wantsKeyRelease?: boolean;
  invalidate?(): void;
  dispose?(): void;
}
```

渲染结果由组件拥有，对调用方不可变；如果组件未发生变化，应返回**与上次相同的数组引用**（引用相等是渲染器记忆化和行虚拟化的前提），只有在内容变化时才返回新数组。

`Focusable` 是独立的：

```ts
export interface Focusable {
  focused: boolean;
  setUseTerminalCursor?(useTerminalCursor: boolean): void;
}
```

光标行为使用 `CURSOR_MARKER`（非 `getCursorPosition`）。获得焦点的组件在渲染文本中发出该标记；`TUI` 会提取它并定位硬件光标。

## 渲染约束（终端安全）

`render(width)` 的输出必须对终端安全：

1. **不要故意让任何一行超过 `width`**。渲染器会对超宽的非图像行做最终防护截断，但组件仍应返回符合宽度限制的输出。
2. **测量可视宽度**，而非字符串长度：使用 `visibleWidth()`。
3. 使用 `truncateToWidth()` / `wrapTextWithAnsi()` 对 ANSI 感知文本做截断/换行。
4. 对外部来源的制表符/内容使用 `replaceTabs()` 做清理（在 coding-agent 渲染路径中还有更上层的清理器）。

最小模式：

```ts
import { replaceTabs, truncateToWidth } from "@musepi/pi-tui";

render(width: number): readonly string[] {
  return this.lines.map(line => truncateToWidth(replaceTabs(line), width));
}
```

## 输入处理与快捷键

### 原始键匹配

对导航键和组合键使用 `matchesKey(data, "...")`。

### 匹配应用快捷键动作

扩展 UI 工厂会收到 `KeybindingsManager`（交互模式；携带默认绑定的内存实例，而非用户的 `keybindings.yml`），因此你可以按 action id 匹配，而不是硬编码键位：

```ts
if (keybindings.matches(data, "app.interrupt")) {
  done(undefined);
  return;
}
```

### 键释放/重复事件

除非组件设置如下内容，否则键释放事件会被过滤：

```ts
wantsKeyRelease = true;
```

然后按需使用 `isKeyRelease()` / `isKeyRepeat()`。

## 焦点、覆盖层与光标

- `TUI.setFocus(component)` 将输入路由到该组件。
- `TUI` 中存在覆盖层 API（`showOverlay`、`OverlayHandle`）。在交互式扩展/自定义 UI 中，`custom(..., { overlay: true })` 通过 `TUI.showOverlay(...)` 挂载你的组件；不带 `overlay` 时则直接替换编辑器组件区域。
- 覆盖层自定义 UI 锚定在 `bottom-center`，使用完整终端宽度/最大高度；当 `done(...)` 关闭流程时，通过返回的 overlay handle 移除。

### 内置全屏界面

coding-agent 集成层还在 `ctx.ui.custom(...)` 之外挂载了内置全屏界面。[Agent Hub](./agent-hub.html) 是 subagents 的实时名册与控制面。其文件支持的 transcript viewer 打开时借用备用屏幕，关闭时在其下方恢复 Hub。

`/pause`（`modes/components/pause-screen.ts`、`runPauseScreen`）挂载第二个内置界面：它会启用进程全局的 `agentPauseGate`（每个 agent 循环会在下一个 model/tool 边界处暂停），渲染带实时计时器的主题色冻结遮罩，并在 `esc` / `enter` / `space` / `ctrl+c` 时释放，使状态行保持暂停状态。GUI daemon 通过 `daemon.pause*` RPC 暴露相同的门控（见 `gui-implementation.md` §1c），因此两个界面共享同一冻结语义。

## 挂载点与返回契约

## 1）扩展 UI（`ExtensionUIContext`）

当前签名（`extensibility/extensions/types.ts`）：

```ts
custom<T>(
  factory: (
    tui: TUI,
    theme: Theme,
    keybindings: KeybindingsManager,
    done: (result: T) => void,
  ) => (Component & { dispose?(): void }) | Promise<Component & { dispose?(): void }>,
  options?: { overlay?: boolean },
): Promise<T>
```

交互模式下的行为（`extension-ui-controller.ts`）：

- 保存编辑器文本。
- 不带 `options.overlay` 时，用你的组件替换编辑器组件。
- 带 `options.overlay` 时，将你的组件作为底部居中覆盖层挂载，而非替换编辑器。
- 聚焦你的组件。
- 在 `done(result)` 时：调用 `component.dispose?.()`，隐藏覆盖层（如果存在），为非覆盖流程恢复编辑器与文本，聚焦编辑器，解析 promise。
  因此 `done(...)` 是完成所必需的。

## 2）Hook/custom-tool UI context（遗留类型）

`HookUIContext.custom` 在 hook/custom-tool 类型中被标注为 `(tui, theme, done)`。
底层交互实现使用 `(tui, theme, keybindings, done)` 调用工厂。JS 消费者可以使用额外参数；类型兼容性仍反映 3 参数的遗留签名。

自定义工具通常通过工厂作用域的 `pi.ui` 对象使用同一 UI 入口点，然后在普通工具内容中返回所选值：

```ts
async execute(toolCallId, params, onUpdate, ctx, signal) {
  if (!pi.hasUI) {
    return { content: [{ type: "text", text: "UI unavailable" }] };
  }

  const picked = await pi.ui.custom<string | undefined>((tui, theme, done) => {
    const component = new MyPickerComponent(done, signal);
    return component;
  });

  return { content: [{ type: "text", text: picked ? `Picked: ${picked}` : "Cancelled" }] };
}
```

## 3）自定义工具调用/结果渲染器

自定义工具和扩展工具可以从以下位置返回组件：

- `renderCall(args, options, theme)`
- `renderResult(result, options, theme, args?)`

当前 `options` 包括：

- `expanded: boolean`
- `isPartial: boolean`
- `spinnerFrame?: number`

这些渲染器由 `ToolExecutionComponent` 挂载。

## 生命周期与取消

- `dispose()` 在类型层面是可选的，但当你拥有定时器、子进程、watcher、socket 或覆盖层时应实现。
- `done(...)` 应从你的组件流程中恰好调用一次。
- 对于可取消的长运行 UI，将 `CancellableLoader` 与 `AbortSignal` 配对，并在 `onAbort` 中调用 `done(...)`。

取消模式示例：

```ts
const loader = new CancellableLoader(
  tui,
  theme.fg("accent"),
  theme.fg("muted"),
  "Working...",
);
loader.onAbort = () => done(undefined);
void doWork(loader.signal).then((result) => done(result));
return loader;
```

## 现实中的自定义组件示例（扩展命令）

```ts
import type { Component } from "@musepi/pi-tui";
import {
  SelectList,
  matchesKey,
  replaceTabs,
  truncateToWidth,
} from "@musepi/pi-tui";
import {
  getSelectListTheme,
  type ExtensionAPI,
} from "@musepi/pi-coding-agent";

class Picker implements Component {
  list: SelectList;
  keybindings: any;
  done: (value: string | undefined) => void;

  constructor(
    items: Array<{ value: string; label: string }>,
    keybindings: any,
    done: (value: string | undefined) => void,
  ) {
    this.list = new SelectList(items, 8, getSelectListTheme());
    this.keybindings = keybindings;
    this.done = done;
    this.list.onSelect = (item) => this.done(item.value);
    this.list.onCancel = () => this.done(undefined);
  }

  handleInput(data: string): void {
    if (this.keybindings.matches(data, "app.interrupt")) {
      this.done(undefined);
      return;
    }
    this.list.handleInput(data);
  }

  render(width: number): readonly string[] {
    return this.list
      .render(width)
      .map((line) => truncateToWidth(replaceTabs(line), width));
  }

  invalidate(): void {
    this.list.invalidate();
  }
}

export default function extension(pi: ExtensionAPI): void {
  pi.registerCommand("pick-model", {
    description: "Pick a model profile",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) return;

      const selected = await ctx.ui.custom<string | undefined>(
        (tui, theme, keybindings, done) => {
          const items = [
            { value: "fast", label: theme.fg("accent", "Fast") },
            { value: "balanced", label: "Balanced" },
            { value: "quality", label: "Quality" },
          ];
          return new Picker(items, keybindings, done);
        },
      );

      if (selected) ctx.ui.notify(`Selected profile: ${selected}`, "info");
    },
  });
}
```

## 关键实现文件

- `packages/tui/src/tui.ts` — `Component`、`Focusable`、光标标记、焦点、覆盖层、输入分发。
- `packages/tui/src/utils.ts` — 宽度/截断/清理原语。
- `packages/tui/src/keys.ts` / `keybindings.ts` — 键位解析与可配置动作映射。
- `packages/coding-agent/src/modes/controllers/extension-ui-controller.ts` — 扩展/hook/自定义工具 UI 的交互式挂载/卸载。
- `packages/coding-agent/src/extensibility/extensions/types.ts` — 扩展 UI 与渲染器契约。
- `packages/coding-agent/src/extensibility/hooks/types.ts` — hook UI 契约（遗留自定义签名）。
- `packages/coding-agent/src/extensibility/custom-tools/types.ts` — 自定义工具执行/渲染契约。
- `packages/coding-agent/src/modes/components/tool-execution.ts` — 挂载 `renderCall` / `renderResult` 组件以及部分状态选项。
- `packages/coding-agent/src/tools/context.ts` — 工具 UI 上下文传播（`hasUI`、`ui`）。  