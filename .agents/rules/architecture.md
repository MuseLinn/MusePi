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

## Workers

Workers re-enter the CLI entrypoint; do not create separate worker entry modules. `cli.ts` calls `declareWorkerHostEntry()` and dispatches hidden `__omp_worker_*` selectors before loading command registrations.

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
