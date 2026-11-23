# UI 插件：座位与组件

插件往界面里加东西，走的是**声明过的座位**（slot），不是往 DOM 里塞。

## 先查座位目录

`cordis_inspect_query({ provider: "slots", method: "catalog" })` 返回每个座位的：容量、作用域、注册时必须传的选项、宿主注入的 props、谁声明并挂载它、替换风险、当前占用者。带 `{ input: { slot } }` 只看一个。

座位名与参数以目录为准。不要凭文档猜、也不要读别的插件的 DOM 或样式去推断位置——选一个已经分配了空间的座位。

## 座位什么时候活着：`lifetime`

目录里每个座位带 `lifetime`：

- `core` —— 壳层常驻（会话页、右栏、设置页、通知等），进程内一直在。直接 `register` 即可。
- `component` —— 由渲染它的那个组件声明（`declaredBy` 指出是哪个），父组件卸载座位就消失。

挂在 `component` 座位上的贡献用 `ctx.slots.inject` 而不是直接 `register`：

```ts
ctx.slots.inject("conversation.composer.dock", () => {
	const dispose = ctx.slots.register({ slot: "conversation.composer.dock", id: "mine", moduleUrl: "./dock.tsx" });
	return dispose;
});
```

座位出现时注册，座位塌缩时自动撤销，座位回来再注册一次；返回的 dispose 彻底停止。直接 `register` 到尚未声明的座位会在加载期报错，而不是静默挂不上。

## 注册

```ts
ctx.slots.register({
	slot: "settings.section",
	id: "my-plugin",
	// 目录给出的选项与 props
}, MyComponent);
```

返回值是 disposer；也可以挂到 `ctx.effect` 上让卸载自动回收。

## 资源要收回

组件挂上的样式、定时器、监听器，凡是加在 `apply` 之外的，都要能在卸载时撤销。组件内的样式作为 React 元素渲染，卸载时随组件消失。

验证一次销毁：卸载插件后界面回到原样，没有残留的定时器或监听器。

## 外观

继承宿主主题：容器与控件用主题色，不要自带一套配色。自带插画可以用自己的颜色。

可见文案走客户端的本地化表，不要写死在组件里。

## 不要做

- 替换应用根节点，或往 `document.body` 再挂一个应用。
- 读别的插件的 DOM、样式表或组件源码来估算位置。
- 在模块顶层做副作用——工厂要保持无副作用，注册与清理都在 `apply` 里。