# `@musepi/client-locale`

Typed locale dictionaries and the runtime `t()` surface. `src/client/zh-CN` and `src/client/en-US` are split by domain; English is `as const satisfies Record<ZhKey, string>`, so a missing or extra key is a compile error. `t()` is called at render time only.
