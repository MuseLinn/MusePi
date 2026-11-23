# `@musepi/client-ui-status`

`StatusText` 渲染一行状态文案，文案变化时交叉淡入淡出；两段文案共用同一个 grid 单元，状态切换不会推动周围布局。动效读取共享的 `--gui-motion-*` token，减少动态效果时直接切换。
