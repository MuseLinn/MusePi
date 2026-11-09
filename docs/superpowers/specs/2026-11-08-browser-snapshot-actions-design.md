# Browser snapshot actions design

## Intent

Continue full browser-protocol alignment by giving the Agent explicit element and visual snapshots and actions that consume them. Keep the existing `browser` tool, named tabs, worker lifecycle, managed GUI ownership, and legacy `open`/`run`/`close` behavior.

## Goals

- `elements` returns a bounded, filtered element snapshot with stable `snapshotId` and `eN` refs, scope, page identity, counts, truncation, cursor, and capture time.
- `visual` returns an image snapshot with screenshot dimensions and the CSS viewport mapping needed for coordinate actions.
- `click`, `fill`, `type`, `press`, `hover`, `scroll`, `drag`, `select_option`, `set_checked`, and `scroll_into_view` consume element refs or visual coordinates instead of requiring freeform JavaScript.
- Snapshots expire after 60 seconds and are bound to their named tab. Continuation uses the same element snapshot; invalid refs, coordinates, snapshots, and cross-tab use fail explicitly.
- Structured action results feed dedicated user cards and the static Agent prompt.

## Non-goals

- This phase does not claim full Kimi parity. Dialogs, tab-control lifecycle, history/downloads, device profiles, visual crop, and drag paths are subsequent phases.
- No second tab registry, arbitrary selector execution through snapshot refs, or change to existing `run` code behavior.

## Constraints

- Element ids come from the existing accessibility observation cache and `tab.id(n)`, not ARIA-snapshot refs or CSS selectors.
- Element continuation requires the original `snapshotId`; it never silently recaptures a changed page.
- Visual coordinates are measured in returned screenshot pixels and mapped through that snapshot's actual image/viewport ratio.
- Output budgets remain bounded: elements default to 100 rows and 8000 chars, with 1–500 rows and 2048–24000 chars.
- Failed or stale snapshots never fall back to clicking the current page blindly.

## Approaches

1. **Compatible snapshot actions (selected).** Add a small expiring snapshot registry and new actions to the existing tool. Reuse observation handles, screenshots, run cancellation, and operation/result details.
2. **Freeform run-only guidance.** Rejected: it leaves schema, evidence, and user cards inconsistent with the reference protocol.
3. **A second browser tool.** Rejected: competing lifecycle and tab ownership would be worse than extending the existing contract.

## Verification

- Unit tests cover schema variants, snapshot TTL/ownership, element filtering/pagination, visual coordinate mapping, and invalid/stale refs.
- Renderer tests cover element rows, visual metadata, and action receipts.
- A real browser page exercises `elements`, ref click/fill, `visual`, coordinate click, and verifies actual DOM changes plus prompt/card evidence.
