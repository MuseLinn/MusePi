# 宿主级插件：进程服务与记忆后端

有些能力不属于某个会话，而是整个宿主进程的：记忆后端、全局服务、文件监视。它们由 `musepi.scope: "host"` 的包在进程启动时注册一次。

## 什么时候用 host 作用域

| 放这里 | 不要放这里 |
| --- | --- |
| 记忆后端 provider | 会话工具（会被每个会话重复注册） |
| 进程级服务 | 界面座位 |
| 文件监视器 | 提示词区块 |

会话装载会跳过 `host` 作用域的包，因此一个进程级注册不会被执行多次。反过来，把会话级能力放进 host 作用域，它会脱离会话生命周期，卸载时也收不回来。

## 注册记忆后端

```ts
ctx.memory.registerBackendProvider({
	id: "my-memory",
	label: "My Memory",
	description: "…",
	create: () => new MyBackend(),
});
```

注册后，新 id 自动出现在 `memory.backend` 的枚举与设置选择器里；卸载后消失。

核心后端（off / local / mnemopi / hindsight / sharpshooter）是内置 provider。`memory.*` RPC 是核心契约——替换实现即可，不要另立方法名。

## 进程级服务与清理

进程级注册要有对应的回收：`ctx.effect` 里的清理在插件卸载时反向执行。监视器、socket、定时器都挂上去，不要让它们活过插件。

进程级状态解释器重启才会清空。调试时注意这一点，改了 host 插件通常要重启 daemon 才能观察效果。