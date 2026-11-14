# Unified Cordis composition design

## Intent

MusePi should use one native Cordis composition and lifecycle model rather than parallel package, bundle, preset, skill, and page-host semantics. This is not a DSH compatibility project. Existing manifests and legacy extensions remain readable where current behavior requires them, but new ownership follows MusePi's Cordis runtime.

## Goals

- Manage installed packages and profile bundles at one package/bundle granularity in the existing Plugins view. Remove the separate Composition tab while retaining composition diagnostics in the shared RPC and detail data.
- Compose profiles from ordered bundle layers and the profile patch, then mount the resulting entries through the existing plugin loader.
- Let presets declare plugin rows, nested groups, configuration, and isolation. Mount preset plugins into each session rather than only projecting them into UI metadata.
- Give each preset a real Cordis `Context` and each plugin a fiber. Apply `isolate` through `Context.isolate()` so provider visibility follows Cordis realm labels; `Extension` remains only a registration record used by the compatibility bridge, never the plugin's identity or lifecycle owner.
- Ship plugin-owned skills with the plugin and remove them when the plugin is disabled or unloaded. Migrate the Android emulator skill to this lifecycle.
- Host the capability-center page through a Cordis-registered `app.capability` single slot. The application shell owns navigation state only; it no longer imports the page implementation.

## Non-goals

- Booting unmodified DSH applications or replacing MusePi native services with DSH services.
- Reproducing Cordis Loader's arbitrary JavaScript evaluation or every DSH `isolate` service name.
- Moving standalone user-installed file skills into synthetic plugins.
- Removing the existing `bundles.*` RPCs used by automation and diagnostics.

## Approaches

1. Port the DSH Loader and profile tree. Rejected: it replaces MusePi's native runtime for compatibility the product does not need.
2. Keep the native runtime and unify composition, scopes, and ownership at its existing seams. Selected: it changes the real mount and lifecycle paths without a second plugin framework.
3. Merge only the UI lists and rename existing fields. Rejected: it leaves preset mounting, service isolation, skill ownership, and static page ownership unchanged.

## Design

### Package and bundle management

`plugins.packages` becomes the package/bundle management feed. Ordinary package entries keep their current shape. Bundle entries additionally identify their management kind, readability, and selected state; a selected-but-missing bundle remains visible as broken. The UI toggles bundles through `bundles.setEnabled` and ordinary packages through `plugins.setEnabled` behind one helper. The Composition tab and `BundleView` are removed. `bundles.composition` remains the detailed composition API rather than a second page.

### Preset scopes

`PresetPluginRow` gains `isolate` and row metadata needed by the loader while group children remain distinguishable from plugin configuration. Profile projection preserves these fields instead of dropping them.

A preset mount plan folds enabled rows into a default Cordis context plus isolated row/group contexts. Each row mounts with `scope.plugin()` and applies service isolation with `scope.isolate(name)`. `mountPlugin` remains the shared import/config/registration adapter; its returned registration records join the session's tool bridge before tools are created. Initial mode selection and hot switching both mount and remove preset-owned tools and prompt sections; removal disposes the actual preset fibers and their effects.

### Skill ownership

A plugin declares its skill during `apply` through `registerSkill`. Markdown and other resources live beside the plugin entry and are imported as build-time assets. Existing extension-skill collection already removes inactive declarations, so no second bundled-skill installation is used for plugin-owned content. The Android emulator moves its skill file under the plugin and stops registering it in the global bundled-skill installer.

### Capability center

Declare `app.capability` as a single slot. A desktop Cordis plugin registers the existing capability-center page implementation from `apps/desktop/src/plugins/capability-center`, so its imports stay within the GUI package. `app.tsx` mounts the slot and retains only the selected tab and navigation callbacks. The Plugins tab consumes the unified package/bundle feed; Skills and Marketplace remain panes of the same plugin-owned page.

## Verification

- Contract tests for bundle/package merging, missing bundles, toggle routing, preset scope visibility, isolated config, mount errors, and hot-switch disposal.
- Regression tests proving the Android skill disappears with its plugin and the capability page has no static host import.
- Focused package checks and renderer tests, then an isolated desktop smoke covering the plugin list, absence of the Composition tab, capability-page mounting, and preset behavior available without a real model.
- Real-model selection behavior is reported separately if credentials remain unavailable.
