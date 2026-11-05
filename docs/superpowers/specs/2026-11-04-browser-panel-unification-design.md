# Browser and right-panel unification design

## Intent

Make the desktop right panel the single visible tab interface for the managed browser. Fix incorrect surface creation and dynamic tooltips, bring the browser menu and device-toolbar behavior up to the reference interaction, and preserve Agent control visibility on the corresponding panel tab.

## Goals

- Open the browser from the add menu with a localized title and browser content, including after restoring previously persisted invalid tabs.
- Keep maximize/restore tooltip, accessible name, and icon synchronized.
- Show an icon on every right-panel tab; browser tabs use favicons with a browser-icon fallback and expose Agent activity.
- Represent each managed browser tab as one right-panel tab. Remove the browser's internal tab strip while preserving managed webview residency and Agent tabId-based control.
- Provide the reference browser-menu capabilities without enabling page-specific controls on `about:blank` or when no page exists.
- Make the device toolbar disabled on blank pages and align its interaction/disabled styling with the shared controls.

## Non-goals

- Replacing the Electron `<webview>` host or changing the Agent/CDP protocol.
- Adding a second browser-session persistence owner.
- Redesigning unrelated right-panel surfaces or browser settings.

## Constraints

- Managed webview elements remain mounted under their stable host; visibility changes must not reparent them or use `display: none`.
- The existing managed-browser host remains the runtime and restart-persistence authority. Panel tabs are a projection, so restored host ids cannot collide with stale persisted panel targets.
- Agent activity and busy ids continue to use managed tab ids.
- Browser panel-tab activation, closing, duplication, budget eviction, split columns, and host-originated tab creation must reconcile in both directions without render loops.
- All new copy has zh-CN and en-US entries. Reuse shared menu, tooltip, icon, segmented-control, and select components.

## Approaches

1. **Managed-host projection (selected).** Keep `managed-browser-host` as the runtime source of truth and derive browser panel tabs from its tabs. Panel interactions call host operations. This preserves guest lifecycle and Agent behavior with a contained synchronization layer.
2. **Panel-owned browser sessions.** Move browser tab persistence and identity into `usePanelTabs`, then recreate host tabs from panel state. This would make the panel authoritative but requires a larger persistence migration and more restoration risk.
3. **Keep both tab strips and only synchronize selection.** This is smaller but retains the duplicate UI and does not satisfy the request.

The selected approach avoids rewriting stable webview and Agent infrastructure while giving the user one tab interface.

## Implementation outline

- Add a pure browser/panel projection module for descriptors, reconciliation decisions, blank-page action gating, and restoration filtering; cover it with contract tests before wiring React.
- Fix add-menu descriptors and migrate the invalid `settings.browser` surface during panel restoration.
- Extend surface tabs with optional icons and Agent badges; use registry icons for built-in surfaces and managed favicons/activity for browser tabs.
- Repair generic tooltip restoration so it never overwrites an externally updated title; keep maximize state and labels on one owner.
- Remove the internal browser tab strip and route new/select/close/duplicate operations through the projection.
- Build the richer browser menu from existing host/IPC capabilities; add only missing main-process bridges. Keep global actions available on blank pages and disable page actions consistently.
- Add disabled semantics to the device toolbar and shared segmented control where needed.
- Update GUI/extension documentation in both locales and the unreleased changelog.

## Verification

- Focused pure-state, tooltip, tab-strip, device-toolbar, and managed-browser tests must demonstrate the new contracts.
- Run the desktop package checks and relevant client-core checks.
- Exercise the real Electron scenario: add/open browser tabs, switch/close/duplicate, reload restoration, Agent activity badge and reveal, maximize/restore tooltip, blank-page menu gating, device toolbar, and the new menu actions. Report any OS dialogs or native behavior that cannot be verified.
