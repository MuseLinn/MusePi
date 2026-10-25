---
name: musepi-code-review
description: 评审 MusePi PR、提交前改动或正确性。覆盖仓库代码质量、GUI 生命周期、provider/id、契约级测试、i18n、扩展 API、中央工具复用和 CHANGELOG。
---

# 评审 MusePi 改动

先读完整 scoped diff 和足够的周边代码，再按消费者可见影响排序：正确性、生命周期、安全、必需行为，最后才是风格。每个发现给出缺陷、位置、影响和证据；不要重复已被门禁强制且无语义缺口的规则。

## 规则归属

按改动范围加载对应权威规则，不在本技能复制：

- 根 `AGENTS.md`：执行边界、包路由、跨域硬约束。
- `.agents/rules/code-quality.md`：TypeScript、Bun、中央工具、日志、TUI 净化。
- `.agents/rules/architecture.md`：catalog、worker、能力缝和插件边界。
- `.agents/rules/testing.md`：测试契约、隔离和验证。
- `.agents/rules/documentation.md`：文档、双语和 README。
- `.agents/rules/release.md`：CHANGELOG 和发布。
- `docs/gui-design.md` / `docs/gui-implementation.md`：GUI 行为、RPC 和生命周期。
- `docs/extensions-dev.md` / `docs/i18n.md`：扩展 API 与词表架构。
- `skill://musepi-prose-standard`：文案语义；`skill://musepi-trim-cot-leakage`：历史与评审叙述清理。

## 必查行为

1. **意图与兼容性**：追踪变更接口两侧，列出被删除或收窄的旧输入、默认和分支；没有声明的兼容路径不能静默消失。错误、取消、所有权和 dispose 与公开契约一致。
2. **异步与生命周期**：检查 setup 发布前竞态、await 期间取消、独立错误上报、回调隔离、重入所有权、完整 detach，以及静默 dispose 的失败可见性。
3. **GUI**：顶层 modal 独占键盘；`DialogFrame` 常挂载并由 `open` 驱动；hooks 位于所有 early return 之前；模型身份为 `provider/id`；会话模型不写 DEFAULT；角色思考阶梯按解析后模型生成。
4. **状态权威**：区分借用与持有、实时与持久状态。缓存、UI 回显、重放和查询视图必须能追溯到权威成功点；失败不能伪装成权威空结果。
5. **能力边界**：新公开 API 有真实生产消费者和明确归属；消费方特定行为不泄漏进通用服务。插件注册来源、启停和销毁域一致。
6. **模型可见面**：核对 prompt、工具 schema、结果和诊断的实际消费者；prompt/可见字符串变更带 snapshot 或行为证据。
7. **真实入口**：测试发布的 loader、bin、worker、daemon 桥或子进程，覆盖手挂插件抓不到的导出和生命周期错误。
8. **测试与证据**：相关检查在最终树上运行；测试断言能在预期回归上失败，并覆盖独立运行和全量并跑。作者报告之外仍需审查语义缺口。
9. **文档与发布**：公开行为、配置、默认值、线字段和事件同步到 owning docs、双语和 changelog；已发布内容不改。

## 报告

把局部缺陷贴到最小相关 diff，跨域问题归为整体发现。blocker 与建议分开。评审回复逐条用代码和测试验证后修复或驳回，不表演性同意。真实正确性问题不能因轮次上限被降级为打磨项。
