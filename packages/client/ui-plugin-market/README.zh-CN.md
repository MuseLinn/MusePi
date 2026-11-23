# `@musepi/client-ui-plugin-market`

插件市场界面：`MarketplaceGrid`（已装 / 目录 / 自定义源三段，含搜索与滚动阴影）、`MarketplaceCard`、`MarketplaceVersionChoice` 与条目类型。

只做展示。目录数据由宿主通过 `client` 传入，`MarketplaceCardAction` 由宿主路由；绑定 `SessionClient` 的 guest 侧 `MarketplacePanel` 适配器留在 `client-core`。