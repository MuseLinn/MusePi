# `@musepi/client-locale`

类型化词表与运行时 `t()`。`src/client/zh-CN` 与 `src/client/en-US` 按域拆分；英文用 `as const satisfies Record<ZhKey, string>`，缺键/多键都是编译错误。`t()` 只在渲染期调用。
