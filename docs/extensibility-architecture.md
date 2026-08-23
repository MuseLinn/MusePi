# musepi 扩展系统架构优化（DSH 对比 + 规范化路线）

> 2026-08-24 · 基于 DSH (@deepseek-ai/dsh-root) 架构分析 + musepi extensibility 审计

## 1. 现状 vs DSH

| 维度 | musepi | DSH |
|---|---|---|
| 插件容器 | 自研 EventBus + ExtensionRunner（事件处理器中心） | vendored **Cordis**（Service/Plugin/Context/typed events） |
| 插件包结构 | 5 个平行子系统：extensions / hooks / custom-tools / custom-commands / plugins | 55 个独立 package，按能力拆分 |
| 加载管线 | 每子系统各自 discover→resolve→import→bind | 统一 boot registry：有序 layer + patch |
| 扩展点 | ExtensionRunner.on() 事件 + slot 组件 | capability seam 有向图 + typed event 目录 |
| 动态插件 | plugins 市场（install/enable/disable） | cordis-host-runner（define/approve/run/undefine + sandbox） |
| 客户端 slot | slot-host.tsx（轮询 extensions.list + blob import） | cordis-client-runner（slot-catalog + providers + guard） |

## 2. 冗余/重复清单（已消除 ✓ / 待做）

### ✓ 已完成
1. **槽位双声明**：GUI_SLOT_HOSTS 与 EXTENSION_SLOT_DECLARATION 相同字符串 → GUI 从 collab-proto 派生（`208266cb0e`）
2. **resolveUniquePaths**：hooks/custom-tools/custom-commands 各自的 seen-set+resolve 循环 → 共享 helper（`bf4d15974e`）

### ⏳ 待做（按优先级）
3. **5 个 loader 的 discover→import→bind 管线**：extensions/hooks/custom-tools/custom-commands/plugins 各有独立 loadX()
   → 目标：统一 `CapabilityLoader<T>` 泛型（discover via loadCapability + resolve + import + bind hooks），各子系统只提供 bind 差异
4. **事件类型平行实现**：shared-events.ts 被多入口重复 import 实例化
   → 目标：事件目录单一权威（DSH event-producer-consumer.md 模式）
5. **扩展启用状态**：实际已是 disabledExtensions 单一权威（scout 误判 pluginsCache——那是缓存非状态）；确认无重复
6. **ExtensionRunner vs hooks runner**：两套并行 runner（timeout/abort/emit）
   → 目标：合并为单一 ExtensionRunner，hooks 作为 extension 的 capability

## 3. 插件化方向（对齐 DSH）

### 3.1 短期（低风险）
- **Loader 统一**：`extensibility/loader-utils.ts` 提供 `discoverCapability<T>()`（loadCapability + resolveUniquePaths），各 loader 的 discover 阶段统一调用
- **事件目录**：在 extensibility 下建 `events-manifest.ts`，列出所有事件类型 + producer + consumer（DSH event-producer-consumer 模式），shared-events 从中导出

### 3.2 中期（中风险）
- **单一 runner**：把 hooks/runner.ts 合并进 extensions/runner.ts，hooks 注册为 extension 的 event handlers（DSH：hooks-claude-code / hooks-codex 作为 cordis 插件）
- **capability seam 文档**：`docs/extensibility-seams.md` 列出 service 声明/实现/消费者（对齐 DSH docs/capability-seams.md）

### 3.3 长期（高风险，需评估）
- **Cordis 引入**：vendored cordis 替换自研 EventBus——获得 DI/typed events/waterfall dispatch/plugin 生命周期
  - 收益：与 DSH 完全对齐的插件模型，模型可写插件（cordis-host-runner sandbox）
  - 成本：核心事件总线重写，所有 extension/hook 迁移，测试全量重跑
  - 决策点：musepi 已声明独立上游（2026-08-17），是否值得大改核心？

## 4. 推荐执行顺序

1. ✅ 槽位单一权威（完成）
2. ✅ resolveUniquePaths（完成）
3. 🔜 loader-utils discoverCapability + 各 loader 接入
4. 🔜 events-manifest 单一事件目录
5. 🔜 hooks runner 并入 ExtensionRunner
6. 🧭 评估 Cordis（独立项目，需架构评审）

## 5. 已验证

- 槽位合并：GUI tsc 通过
- resolveUniquePaths：coding-agent tsc 通过
- 全部推送 origin/main
