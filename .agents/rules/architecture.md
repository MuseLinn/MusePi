# Architecture and Generated Artifacts

Load for package boundaries, catalog changes, workers, and capability registration.

## Package and catalog boundaries

The package map lives in the root `AGENTS.md`. `packages/coding-agent` is the default work area only when the request does not name another surface.

Catalog values and model helpers come from `@musepi/pi-catalog/<module>`, never through `@musepi/pi-ai`. The AI barrel exposes only model/effort types used by its own signatures; type-only imports of those types are allowed.

`packages/catalog/src/models.json` is generated. Change the owning source instead:

- API/per-id resolution: `packages/catalog/src/provider-models/openai-compat.ts` and related resolvers.
- Provider descriptors: `CATALOG_PROVIDERS` in `provider-models/descriptors.ts`.
- Generator fixups: `packages/catalog/scripts/generate-models.ts`.
- Thinking policies: `src/model-thinking.ts`; identity parsing: `src/identity/classify.ts`.

Run `bun run gen:models` and deliver the regenerated file with the source change. Regression tests target the resolver/descriptor, not bundled JSON. Whether to commit remains governed by the user's explicit instruction.

## Package boundaries

跨包引用只走包名，并在引用方 `package.json` 声明依赖。`scripts/check-package-boundaries.ts` 拒绝三类写法：

- 未声明的 workspace 包引用（本地靠符号链接能解析，干净安装或发布后才失败）。
- `src/` 里用相对路径爬出本包（测试可以跨包取无导出的内部实现，已由 `scripts/package-boundaries-baseline.json` 记账，只挡新增）。
- `packages/*` 库包反向依赖 `apps/*` 或 `tools/*`。

修法是补依赖声明（已发布的包用 `catalog:`，未发布的用 `workspace:*`），不是把违规记进 baseline。baseline 只留“没有导出可替代”的测试期例外。

## Model identity

`formatModelString` returns `ModelRef` from `@musepi/pi-catalog/identity`, a compile-time-only brand over the canonical `provider/id` string. Persisted sessions, settings and CLI arguments keep plain strings; the brand only stops internal code from accepting a bare id where a resolved identity is required.

Resolution runs in `packages/coding-agent/src/config/model-resolver.ts`:

- a bare id served by several providers resolves within `preferredProvider` when the caller knows it; otherwise the warning names the winner and up to four alternatives;
- a pattern that only exists as the prefix of longer ids is rejected with the closest ids instead of silently downgrading;
- an explicit provider prefix keeps shorthand matching inside that provider.

## Generated artifacts

`gen:tool-views` 写入 `packages/coding-agent/src/export/html/tool-views.generated.js`；`scripts/verify-generated.ts` 在内存里重建并逐行比对，渲染层改了却忘记重生成会让 `check:tools` 失败。新增确定性的生成器注册到该脚本的 `ARTIFACTS`。

`models.json` 仍是本地生成步骤：发现流程需要 provider 网络与本地凭据，裸 CI 无法复现，所以没有字节级漂移门禁；它的回归测试仍打在 resolver 与 descriptor 上。

## Workers

Workers re-enter the CLI entrypoint; do not create separate worker entry modules. `cli.ts` calls `declareWorkerHostEntry()` and dispatches hidden `__musepi_worker_*` selectors before loading command registrations.

Spawn through `workerHostEntry()` from `@musepi/pi-utils`. Use the CLI host when available and retain the direct-module fallback for tests, SDK embedding, and standalone tools. Every new worker kind needs a selector in `cli.ts` and the fallback branch.

Validate workers with `omp --smoke-test` (or a sibling probe for a different module graph). The probe must cover the actual install/runtime shape that can load the worker.

## Capability seams

New L2 services, `BUILTIN_TOOLS` entries, slash-command domains, registration methods, widgets, and slot families declare in their authoritative registry:

1. Name and namespace.
2. Inputs and outputs.
3. Lifecycle.
4. Enable/disable behavior.
5. Conflicts.
6. Inspection entry point.

Register the declaration anchor in `docs/capability-seams.md`. Prefer overlay-controlled activation; always-on behavior requires a reason. New extension APIs also update both language versions of `docs/extensions-dev.md`.

## Plugins and providers

Keep the extension-center providers distinct: `omp-plugins` is the upstream OMP package ecosystem; `musepi-extensions` is MusePi's plugin system. New MusePi plugin capabilities use the latter rather than being folded into `native`.

Pluginization should move ownership and lifecycle into a real Cordis plugin where that improves the boundary; do not mechanically wrap every function. First identify the authoritative registry, activation owner, disposal owner, and domain. Preserve CLI/TUI/GUI parity and existing `pi`/OMP compatibility surfaces.
