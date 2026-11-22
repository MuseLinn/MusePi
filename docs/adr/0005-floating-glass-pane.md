# ADR 0005: 浮层玻璃收敛为一个 pane primitive

- 状态：已接受（2026-11-23）
- 背景：输入框此前是一圈 0.5px 均匀白边 + 组件各自的填充/阴影；浅色直接用白，白底上的白 pane 让上下亮带消失。对照开源的 KiroCrew（`website/src/styles/liquid-glass.css`、`components/Glass.tsx`）后确认，参考实现把材质收敛到一个 `Glass`/`liquid-glass` primitive：tint 叠在模糊背景上，上下各 1px 亮带、左右各 1px 暗线、亮带外侧 0.5px 暗发丝，四角不画边；浅色 tint 是 45% 灰而不是白。
- 决定：材质只有一个所有者 `.gui-liquid-glass`，tokens 在 `tokens.css` 的 `--glass-pane-*`。宿主只加类、设圆角和布局，不再声明 fill、border、box-shadow、模糊或光溢层。输入框、欢迎页输入框、顶栏两个胶囊、设置页“半透明面板”预览、会话 recap 行全部接入；只需要 warp 的能力页工具条保留类并清零填充/阴影/`::after`。
- 理由：
  - 实测对照：浅色填充 `#F8F8F8` 级别、亮带纯白、侧线黑 24%、外发丝黑 20%；深色亮带 22%、侧线 14%、外发丝黑 50%、无偏移 18px 阴影。这些关系比“更亮的边框”更能解释参考实现的高级感。
  - 单一所有者消除了四处手抄配方（composer、settings 预览、recap、顶栏胶囊），也消除了 `--gui-input-shadow` 这种只为转发而存在的别名。
  - 光溢必须画在 warp 层之上：放在宿主自身背景上会被 24px 背景模糊抹平，实测内侧从 48 直接掉到填充值。
- 影响：
  - 规范与 token 表在 `docs/gui-components.md` §Glass pane；契约测试 `apps/desktop/test/glass-pane.test.ts`。
  - 新增 pane 消费者只加类；需要不同厚度或色相时覆盖 `--glass-pane-tint`/`--glass-pane-band`/`--glass-pane-spill`，不复制材质。
  - 浅色不再允许白 tint；深色仍由主题的 `bg-raised` 派生。
- 被否决的方案：整圈 1px 轴向 rim（第一版；四角闭合成边框）、浅色白填充、每个组件各自维护配方。