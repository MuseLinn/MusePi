# Browser extensions and profile-data UX design

## Intent

Make the managed browser's existing profile, extension, and real-Chrome capabilities discoverable without duplicating its tab interface or weakening Agent control. Adopt the useful interaction hierarchy evidenced by the installed ChatGPT package: an extensions toolbar entry, an explicit import card, grouped browser settings, and truthful data-type/status feedback.

## Goals

- Add a pinned, optional extensions button to the managed-browser toolbar. Its non-modal popup exposes Chrome data import, the MusePi Browser Relay, shared-Chromium extensions, and a route into settings.
- Split Settings → Browser into General, Extensions, and Data views using the shared segmented control.
- Keep the Browser Relay and its real-Chrome workflow visible alongside the managed browser rather than replacing it.
- State that the existing importer copies cookies and localStorage into the shared automation Chromium. Do not imply password import, managed-partition import, profile selection, or synchronization.
- Preserve the existing right-panel tab projection, stable webview host, Agent/CDP bridge, and per-session tab ownership.

## Non-goals

- A second tab strip, a new browser engine, or changes to guest lifecycle.
- Password decryption, a password manager, Chrome extension installation into Electron, or managed-partition profile import.
- A new floating-menu implementation, new dependencies, or unrelated settings redesign.

## Constraints

- The shared automation Chromium and the managed Electron partition are different data stores. Every import/extensions surface must name the shared-Chromium destination.
- Popups use `useFloatingMenu`; settings tabs use `Segmented`; browser preferences use the existing renderer-local preference/event pattern.
- New copy is bilingual. Existing user changes in shared documentation and i18n files remain intact.

## Approaches

1. **Layered absorption (selected).** Reuse existing RPCs and host state, add shared import/extension components, and regroup settings. This delivers the interaction gains with small, testable changes.
2. **Full browser-profile platform.** Build native password, extension, and managed-profile import support. This requires a separate security design and platform validation; the current UI work must not pretend it exists.
3. **Screenshot-only replica.** Copy the toolbar and settings appearance without clarifying data ownership. Rejected because it would make the existing shared-Chromium import look like a managed-browser or password import.

## Design

- `BrowserImportCard` owns import RPC state, dismissibility, progress, and inline success/error feedback. The toolbar card is dismissible and links to the full Data view; the settings card performs the same import directly.
- `BrowserExtensionsPanel` owns Relay status/actions and shared-Chromium extension inventory. A compact variant serves the toolbar popup; the full variant serves Settings → Extensions.
- A renderer-local browser-settings model owns the selected settings tab, toolbar visibility, full-URL preference, and change events. The toolbar and both settings consumers share it instead of introducing duplicate storage keys.
- Settings → General retains engine, Agent, desktop-operation, and runtime-status controls. Settings → Extensions contains Relay, extension inventory, and toolbar visibility. Settings → Data contains import and clearing operations.
- The toolbar popup remains closed until requested, is dismissed by outside click/Escape through the existing floating-menu primitive, and fits narrow panes with internal scrolling.

## Verification

- Contract tests cover preference parsing/events, import success/failure, Relay actions, toolbar visibility, settings navigation, and menu behavior.
- Run focused desktop/client-core checks and the desktop package check.
- Exercise the real Electron UI: open/dismiss the extensions popup, hide/show its toolbar button, switch settings views, run mocked import/Relay actions, and confirm existing browser tabs and Agent controls still work. Report unverified native OS or real-Chrome behavior explicitly.
