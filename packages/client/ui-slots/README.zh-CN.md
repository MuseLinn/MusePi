# `@musepi/ui-slots`

桌面壳与 Cordis 贡献共用的类型化 UI 槽位声明。每个能力包在自己的 `src/client/contract/slots.ts` 里声明座位；宿主按座位注册组件，扩展按槽位 id 贡献。

`defineSlot(name)` 会按 `@musepi/collab-proto/extension-slots`（唯一声明权威）校验名称。
