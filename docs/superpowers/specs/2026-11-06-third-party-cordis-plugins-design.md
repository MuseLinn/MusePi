# Third-party Cordis Plugins Design

## Intent

Integrate Superpowers and Modern Web Guidance as real Cordis plugins while preserving the existing marketplace install, update, enable/disable, and disposal behavior.

## Findings

- Kimi Code installs marketplace packages into a managed copy and prompts before upgrading; it does not silently replace installed plugins.
- MusePi already refreshes catalogs after 24h, compares versions per scope, upgrades into new cache directories, preserves disabled state, and mounts runtime links.
- Superpowers already ships `.pi/extensions/superpowers.ts`, which MusePi can mount. It injects the bootstrap into provider context and resets after session start/compaction.
- Modern Web Guidance ships a skill and CLI declaration but no Cordis entry. It needs an adapter; copying a static package would make updates drift.

## Approaches

1. **Chosen: adapt only the cached installation.** Superpowers gets an explicit `musepi` declaration pointing to its existing Pi entry. Modern Web Guidance gets a generated `musepi` declaration and adapter entry. Marketplace upgrades recreate both.
2. **Bundled static wrappers.** Rejected because they pin upstream content and cannot follow MarketplaceManager versions.
3. **Modify upstream managed directories.** Rejected because they are user-owned, not persistent, and not delivered with MusePi.

## Design

`adaptThirdPartyCordisPlugin(cachePath)` runs immediately after `cachePlugin`. It edits only that cache's `package.json` and writes no source files. Superpowers receives a `musepi` declaration referencing `./.pi/extensions/superpowers.ts`; its existing `pi` declaration remains intact.

Modern Web Guidance receives a `musepi` declaration referencing `./cordis/index.ts` and a generated adapter. The adapter reads the packaged `skills/modern-web-guidance/SKILL.md`, registers it as `modern-web-guidance:modern-web-guidance`, and registers a `modern_web_guidance` tool with `search`, `retrieve`, and `list` operations. The tool uses a packaged CLI when present and otherwise invokes the upstream `npx -y modern-web-guidance@latest` interface with platform-correct `npx.cmd` on Windows, a 60s deadline, and bounded output. Errors and nonzero exits surface rather than becoming empty results.

## Lifecycle and compatibility

- Only the cache is modified; MarketplaceManager continues to own version checks, upgrades, runtime links, and enabled state.
- Existing `pi` behavior is preserved for Superpowers, including context bootstrap and compaction reinjection.
- Modern Web Guidance registers a real tool and skill through `ExtensionAPI`; disabling the package removes both through normal Cordis disposal.
- No install-time upstream scripts execute. Tests use temporary roots and a fake process spawner, never the production plugin store.

## Verification

- Manifest adaptation is idempotent and preserves existing package fields.
- Superpowers mounts through the real `mountPlugin` and returns bootstrap context.
- Modern Web Guidance mounts, lists its skill/tool, and its tool returns actual process output.
- Nonzero process exits, unknown operations, oversized output, and stale/disabled lifecycle behavior have explicit tests.
- Focused plugin tests precede package checks and documentation/changelog validation.
