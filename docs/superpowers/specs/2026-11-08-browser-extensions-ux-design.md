# External browser integrations and profile-data UX design

> Superseded by [Managed-browser extensions design](2026-11-08-managed-browser-extensions-design.md). The managed toolbar now supports real extensions loaded into its own partition; external Relay and shared-Chromium integrations remain in Settings.

## Intent

Make external-browser and profile capabilities discoverable without duplicating the managed tab interface, weakening Agent control, or presenting them as managed-browser extensions. Keep the useful interaction hierarchy found during reference analysis: explicit import feedback, grouped settings, and truthful data ownership.

## Goals

- Split Settings → Browser into General, External browser integrations, and Data using the shared segmented control.
- Keep Browser Relay and shared-Chromium extension inventory in External browser integrations only. Do not render an extensions button in the managed toolbar.
- State that the existing importer copies cookies and localStorage into the shared automation Chromium. Do not imply password import, managed-partition import, profile selection, or synchronization.
- Preserve the right-panel tab projection, stable webview host, Agent/CDP bridge, and per-session tab ownership.
- At ≤480px, move annotation, developer tools, and new-tab into More actions so the address field remains usable.

## Non-goals

- A managed extensions popup, a second tab strip, a new browser engine, or changes to guest lifecycle.
- Password decryption, a password manager, Chrome extension installation into Electron, or managed-partition profile import.
- A new floating-menu implementation, new dependencies, or unrelated settings redesign.

## Constraints

- The shared automation Chromium and the managed Electron partition are different data stores. Every import/extensions surface must name the shared-Chromium destination.
- Browser Relay and shared-Chromium extensions are external integrations, not managed-browser extensions.
- Settings tabs use `Segmented`; browser preferences use the existing renderer-local preference/event pattern.
- New copy is bilingual. Existing user changes in shared documentation and i18n files remain intact.

## Approaches

1. **External-integration settings (selected).** Reuse existing RPCs and host state, keep shared import/extension components in settings, and remove the managed-toolbar extensions entry and preference. This preserves capability discovery without misrepresenting ownership.
2. **Managed extensions popup (rejected).** A toolbar popup makes external Relay and shared-Chromium data look like managed capabilities and offers no actual managed-extension support.
3. **Full browser-profile platform.** Native password, extension, and managed-profile import require a separate security design and platform validation; the current UI must not pretend it exists.

## Design

- `BrowserImportCard` owns import RPC progress and inline success/error feedback in Settings → Data.
- `BrowserExtensionsPanel` owns Relay status/actions and shared-Chromium extension inventory in Settings → External browser integrations.
- A renderer-local browser-settings model owns the selected settings tab, full-URL preference, and change events. No extensions-toolbar preference exists.
- Settings → General retains engine, Agent, desktop-operation, and runtime-status controls. Settings → Data contains import and clearing operations.
- The managed overflow menu retains new-tab, annotation, and developer tools, allowing duplicate toolbar buttons to hide at narrow widths without losing those actions.

## Verification

- Contract tests prove the managed toolbar offers no external Relay or shared-Chromium extensions, settings views retain their existing controls, imports report real results, and preferences/events work.
- Run focused desktop/client-core checks, root `check:tools`, and the desktop build.
- Real Electron evidence distinguishes working settings/import behavior from any remaining native visual-verification limits. Do not claim password import or real-Chrome integration without a live probe.
