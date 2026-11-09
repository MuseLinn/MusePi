# Managed-browser extensions design

## Intent

Provide a real extensions menu in the managed browser without confusing its extension partition with the external Browser Relay or shared automation Chromium. The earlier removal was overbroad: the menu is valid when its contents and actions belong to the managed partition.

## Goals

- Show only extensions actually loaded into `persist:musepi-managed-browser`, with name, version, and real empty state.
- Let the user explicitly choose an unpacked extension directory, review its declared permissions, install it into the managed partition, and remove it later.
- Persist extension directories so they load again on application restart; use the actual Electron session inventory for display.
- Keep Browser Relay and shared-Chromium extension inventory exclusively under Settings → External browser integrations.

## Non-goals

- Chrome Web Store installation, CRX files, Chrome API compatibility claims, or Relay installation in the managed partition.
- Silent installation, arbitrary path input, or loading code without an explicit user action and permission review.
- Changes to managed webview lifecycle, tab ownership, Agent/CDP behavior, or the shared-Chromium importer.

## Constraints

- Electron 43 requires `loadExtension` on every application boot. A JSON file in Electron `userData` stores only extension id, name, version, path, and manifest-declared permissions, never page data or credentials.
- Only absolute directories containing `manifest.json` are accepted. The manifest must have a positive integer `manifest_version`, nonempty `name` and `version`, and an optional string-array `permissions`.
- Installation uses an explicit directory picker and a permission-review step. Removal unloads the extension and deletes its record, not the source directory.
- The managed session remains the display authority. Loading failures stay visible and do not create phantom installed rows.

## Approaches

1. **Managed-session extensions (selected).** Add main-process list/install/remove IPC, persistent directory records, and a renderer popup backed by the actual managed session. This provides real functionality and a truthful menu.
2. **Menu with external integrations.** Rejected because it presents another browser's Relay and extensions as managed capabilities.
3. **No extensions menu.** Rejected because Electron supports real managed-session extensions and the reference menu is useful.

## Design

- Main process validates manifests and stores records. At startup it loads every valid recorded directory best-effort and records errors for display instead of preventing browser startup.
- `managed-browser:extensions-list` returns loaded extensions plus any stored load errors. `managed-browser:extensions-choose` validates the picked directory and retains the reviewed candidate in the main process. `managed-browser:extensions-install` loads that same candidate only after explicit confirmation, without opening a second picker. `managed-browser:extensions-remove` unloads by id and removes only the persistent record.
- Preload and `env.d.ts` expose typed wrappers. A small managed-extension popup component owns refresh, permission confirmation, loading, removal, and error states without RPC to the daemon or external browser.
- The managed toolbar restores its Extensions button. The popup has no Relay, shared-Chromium inventory, or external-profile import.
- Documentation explicitly distinguishes managed extensions, external Relay, and shared-profile data.

## Verification

- Main-process IPC tests use an isolated extension directory and mocked session: manifest validation, permission confirmation, duplicate handling, list/remove, persistence, and native errors.
- Renderer tests cover real empty/loaded/error states, install confirmation, and removal.
- Real Electron installs a tiny unpacked extension into an isolated userData directory, lists it, and removes it without touching the source directory or production profile.
