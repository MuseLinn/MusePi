# 召回探针（recall batteries）

针对[分类](../SKILL.md#分类)的探针。每次命中都需要语义判断——探针按设计会过匹配，
也按天性会漏：每一轮清理都会发现探针抓不到的个案，所以要与无模式通读范围内最密
文案配合使用。

## 调用规则

- 加 `--hidden --glob '!.git/**'`，让 `.omp/`、`.agents/`、`.claude/` 也被搜；
  ripgrep 默认跳过点目录，而最大的漏检风险就在这些目录里。
- 排除项放最后，避免后面的 include 重新引入：`--glob '!vendor/**' --glob
  '!node_modules/**' --glob '!*.snap' --glob '!packages/*/node_modules/**'`
  （本 skill 自己的目录会引用泄漏措辞做校准，也排除）。
- 自然语言行带 `-i`，让句首大写命中（"This PR adds…"、"Probably fine…"）；第一行
  匹配代码模式，保持区分大小写——`-i` 会把 `\bT\d\b` 和 `\bP-I\b` 变成噪声。
- 零命中模式在被信任前必须先测一次已知正例，确认它真的能匹配。

## English battery

```sh
rg -n --hidden '\(decision \d|\(audit [A-Z]\d|design §|plan §|design ledger|\(B ruling|\bP-I\b|\bW\d\b|\bT\d\b' ...
rg -n --hidden -i 'this PR|this branch|this stack|later PR|previous commit|this commit' ...
rg -n --hidden -i 'used to |no longer|previously|the old |was renamed|was moved' ...
rg -n --hidden -i '\bv1\b|this cut|\bcut \d|\btoday\b|\bfor now\b|roadmap' ...
rg -n --hidden -i 'rejected in review|review round|reviewer|as of v\d' ...
rg -n --hidden -i 'probably |should be enough|should suffice|it simply|is safe —|is safe --' ...
rg -n --hidden '§\d' ...
```

## Chinese battery

```sh
rg -n --hidden '设计稿|评审|上一?轮|旧版|老的|不再|以前|本版|遗留|私有' ...
rg -n --hidden '(^|[^a-zA-Z])端([^a-zA-Z]|$)' --glob '*.md' ...
```

## 已知误报族

清理时判定并保留过，预期还会再见：

- **工具义的 "used to"** —— "the key used to sign requests" 是工具义，不是时间义；
  时间义前面有主语状态（"colors used to come from…"）。
- **运行时新旧** —— "旧连接排空后新连接才接受"说的是交接中的活对象，不是仓库状态。
- **流程文档里的 "PR"** —— 讲 PR 工作流本身的文档（"PR body 应该…"、模板、本仓库
  的流程说明）合法地说 PR；禁令针对"某篇文档采纳了一个 PR 的视角来谈代码"。
- **作为协议或路径段的 `v1`** —— `/v1/chat` 端点和线格式名是标识符，不是版本戳。
- **有归属者的 `§N`** —— 外部标准（RFC 9110 §10.1.5）和自有 §-编号的已提交文档
  可以按节引用。
- **对照义的 "actually" 和名词 "wait"** —— 普通英语，不是含糊；已提交行不会命中
  它们，只有你扩展更宽的含糊模式时才会浮出来。
- **生成时间戳和 CLI 输出样例里的 "today"** —— 录制输出保留原声。
- **zh 文案里的"本版本"** —— 版本化产物语境里对 "this release" 的合法翻译；被禁的
  指示词是裸 "本版"，镜像 "this cut"。
- **CHANGELOG 的变更史** —— CHANGELOG 本来就是变更叙述的合法家；分类 3 的禁令
  针对 docs/README/JSDoc 等现状面。
