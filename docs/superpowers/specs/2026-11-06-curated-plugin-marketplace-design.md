# Curated Plugin Marketplace Design

## Intent

Finish the product path for third-party Cordis plugins: curated discovery, version-pinned execution, cancellation, and install/upgrade acceptance.

## Approaches

1. **Chosen: embedded curated metadata plus production-only injection.** Default catalogs are visible without network or installation. `includeDefaultMarketplaces` is enabled at production factories, while isolated tests and custom managers opt out.
2. **Auto-install defaults.** Rejected because downloading and executing third-party code must remain a user action.
3. **Unversioned runtime npx.** Rejected because `@latest` bypasses the installed version's compatibility and trust boundary.

## Design

`DEFAULT_MARKETPLACES` supplies `superpowers-dev` and `googlechrome` with catalog metadata and source URLs. Registry reads merge these entries only when the manager opts in. Missing catalog files fall back to embedded catalogs; normal refresh replaces them. Duplicate add is rejected, built-ins cannot be removed, and update/check/install use the existing source resolver.

The Modern Web adapter reads its own package version and invokes `modern-web-guidance@<version>` when no packaged CLI exists. Its registered skill gains a Cordis tool-mapping paragraph so the model uses the registered tool. The process runner accepts the caller's `AbortSignal` and kills the child on abort, timeout, or output overflow.

## Acceptance

- Curated lists expose both plugins without network and without installing them.
- Modern Web uses the installed version, not `@latest`; caller cancellation kills the process.
- A local marketplace install mounts the adapted plugin, update detection reports the new version, disable state survives upgrade, and the adapted CLI version follows the upgraded package.
- Superpowers bootstrap is verified against the actual upstream package; model-driven skill-choice behavior is not claimed as verified without a real-model run.

## Constraints

- No production registry or plugin-store writes in tests.
- No generic adaptation for unknown agent plugins.
- Preserve existing scope, enable/disable, source-resolution, and disposal behavior.
