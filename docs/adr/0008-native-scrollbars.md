# ADR 0008: 滚动条回到原生，皮肤只保留配色与纹理

- 状态：已接受（2026-11-26）
- 背景：桌面端此前把系统滚动条全局隐藏（`gui-base.css` 的 `* { scrollbar-width: none !important }`），用 `plugins/ui-theme/rail.tsx` 的 JS 浮层自绘位置、拇指、拖拽、闲时淡出与层级。代价是 24 槽轨池、600ms 探活、每帧 `matchMedia`、每次滚动的空转 `armSettle` 定时器，以及被 `!important` 压死的 9 处 per-surface 滚动条样式（设置对话框、提醒列表、音乐队列等）。同一份 `client-core/src/styles/base.css` 已经在 mobile/Harmony 上使用原生圆角条，桌面是唯一例外。
- 决定：滚动条交回引擎。`packages/client-core/src/styles/base.css` 拥有唯一的规范：调色板 `--mp-scrollbar-bg-l1/-l2` 与 hover 对、`--mp-scrollbar-tint` 间接层、`@supports not selector(::-webkit-scrollbar)` 双路径分流。表面通过把 tint 重绑到 l2 对选择海拔。`ui-theme` bundle 只保留皮肤目录 `skins.ts` 与配方 `skins.css`，皮肤 = 调色板 + 拇指图层配方，不拥有任何行为；内置 `classic` / `builtin-snake` / `builtin-gummy-rainbow`，导入与贡献皮肤只覆盖调色板。
- 理由：
  - 尺寸、拖拽、悬停、键盘、减少动效与系统无障碍面都由引擎提供，删除约 1200 行 JS 与 350 行 CSS，也删除常驻探针与监听器。
  - 海拔重绑从「每个表面手写滚动条样式」收敛为一次 tint 重绑；`!important` 隐藏消失后，那些局部设计不再失效。
  - 皮肤仍是可替换的外观层：配方由 `html[data-scrollbar-skin]` 选择，颜色走可重绑调色板，弹层/菜单换色对所有皮肤生效。
- 影响：
  - 滚动条占真实布局宽度（默认 5px，皮肤夹在 6–16px）；需要稳定的面板用 `scrollbar-gutter: stable`。桌面首次与 mobile 同源。
  - 吃豆人皮肤退役：原生拇指无法承载进度驱动的已吃轨迹与动画字形，已持久化的 `builtin-pacman` 解析为 `classic`。回合导航条的 `pacman` 样式是另一个设置，不受影响。
  - `shell.overlay` 不再由主题 bundle 占用；宿主不再提供 `<FloatingScrollbar/>` 回退，其他插件仍可贡献覆盖层。
  - 契约测试 `apps/desktop/test/scrollbar-skins.test.ts`；`ui-theme` 只剩 `settings.item.appearance.rail` 一个席位。
- 被否决的方案：保留 JS 轨并只在皮肤层做原生化（仍要池、探活与拖拽）；把吃豆人降级成不可交互的装饰层叠在原生 gutter 上（视觉拇指与不可见原生拇指的长度会漂移，只适合 glyph 标记）；继续提高 `gui-base.css` 的优先级来「修复」局部样式（两套系统并存）。
