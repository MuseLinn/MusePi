---
name: musepi-ci-test-reliability
description: Use when designing, modifying, or diagnosing MusePi CI workflows, test sharding, Bun version drift, release gates, or nondeterministic async tests.
---

# MusePi CI 与测试可靠性

先读 `.agents/rules/testing.md`、相关 `package.json` scripts、目标工作流和 `scripts/ci-test-ts.ts`。本技能拥有 CI 执行拓扑与可靠性流程；测试语义、生产数据隔离和交付证据仍归 testing 规则，发布操作归 release 规则。

## 先确定执行拓扑

不要只按单机串行推断测试是否安全。当前测试可能同时存在：

1. 同一 `bun test` 进程中的多个文件。
2. 同一 chunk 池中的独立 Bun 进程。
3. 同一 Actions runner 上的独立脚本或构建进程。
4. 共享自托管宿主、缓存或外部服务的多个 job。

进程隔离不能隔离端口、可预测临时路径、全局服务或继承的子进程。为每个资源确定所有者、原子分配方式、就绪信号、清理动作和静默完成信号。优先 `listen(0)`、`mkdtemp` 和每测试独立命名空间，不用“先找可用端口再绑定”或固定共享目录。

全局环境变量、cwd、fake timers、locale、注册表和 `globalThis` 是独占可变资源。优先注入实例依赖；必须修改时，保存 absent/present 原状态，立即登记恢复，并把范围缩到最小。遵守仓库禁止 `mock.module()` 的约束。

## 运行时版本只有一个事实源

根 `package.json` 的 `packageManager` 决定 CI 和发布使用的 Bun 版本。所有 `oven-sh/setup-bun` 步骤使用 `bun-version-file: package.json`，包括自托管 runner；不得使用浮动 `1.4`、另写固定旧版本或直接接受预装 Bun。`@types/bun` 只提供类型，不选择运行时。

缓存键同时包含解析后的 Bun 版本和 lockfile。升级运行时时，用同一版本复现失败并运行相关套件，不能只改类型包或本地版本。

## 修改 CI 时保持门禁真实

- Package scripts 是命令事实源；工作流调用这些 scripts，不复制另一套测试命令。
- 新测试包必须进入一个 CI 桶和本地完整清单，且各出现一次。用 `bun scripts/ci-test-ts.ts workspace --dry-run` 等清单检查证明没有静默漏跑。
- Linux TS 测试只依赖 x64 native 产物；其他平台产物服务发布。不要为测试等待无关的慢平台，也不要在 PR 启动所有步骤都跳过的空 job。
- Rust 与 TS 的消费者都应在合并前验证。main/release 的额外平台构建不能成为跳过 PR Rust 验证的理由。
- 发布 job 必须在 `needs` 和 `if` 中要求实际验证门禁成功。只创建 gate、打印状态或保留注释不构成发布保护。
- Path filters 必须覆盖会影响该工作流的 manifest、lockfile、脚本、生成器、action 和配置。新增输入时同步 push 与 pull_request。
- 对运行时版本、测试清单和发布依赖等 CI 契约，在 `scripts/ci-contract.test.ts` 添加少量解析或行为检查；不要为每一行 YAML 复制静态回声测试。

## 异步测试按状态同步

固定 sleep 不是 setup 完成或 teardown 结束的证据。等待明确的握手、事件、状态迁移、已持有 promise 或可观察条件；超时只用于给等待设上限，不用于决定结果是否正确。

网络监听、子进程、worker、服务器和流必须完整清理并等待退出/关闭。`abort()`、`close()` 或 `kill()` 本身不等于 quiescence。测试需要证明晚到回调不会污染后续测试。

按 CI lane 的实际资源竞争设置超时。固定几百毫秒的“防止 promise 永久 pending”保护会把调度延迟误报为产品失败；使用测试框架预算内的宽松上限，并命名正在等待的状态。提高超时、加重试、整桶串行或放宽断言前，必须先定位等待条件，不能把它们当作通用 flake 修复。

## 诊断 CI 失败

1. 保存 run/job、完整错误、精确命令、OS、Bun 版本和分桶清单；区分断言失败、模块加载失败、运行时崩溃、watchdog 和基础设施失败。
2. 用相同代码与相同 Bun 版本做最小复现。本地不同 OS/版本通过只能作为对照，不能宣称 CI 已修复。
3. 对照最近成功 run 与当前配置、runner image 和变更。多组件链路分别检查输入、输出和环境传递。
4. 先形成单一根因假设并只改变一个变量。不得通过吞掉错误、跳测或反复重跑寻找一次偶然绿色。
5. 只对已识别的 Bun fatal-signal 崩溃使用现有 chunk 重试；退出码 1、超时和模块解析错误不是可自动重试的瞬态故障。
6. 将结果分类为回归、已有问题或环境限制。真实修复需要失败对照、修复后同一复现，以及受影响套件证据。

## 验证与交付

先跑 CI 契约测试和相关 dry-run，再跑受影响的包测试与静态检查。工作流语义、runner 版本和平台行为最终以目标 Actions run 为准；未推送或未执行的远程验证必须明确标为 pending，不能写成“CI 已绿”。发布前另按 `.agents/rules/release.md` 检查 changelog 与实际发布门禁。
