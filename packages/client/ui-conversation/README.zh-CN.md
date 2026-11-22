# `@musepi/client-ui-conversation`

会话能力的座位契约。`src/client/contract/slots.ts` 声明 composer、input、hero 与 session-info 的座位；桌面宿主按座位注册组件，Cordis 贡献按槽位 id 进入。

该能力的组件会逐步迁入；迁移完成前，宿主保留实现，只从这里引用契约。
