# Remaining visual actions and panel protocol

## Intent

Finish the next set of browser protocol gaps without weakening safety: reveal the existing managed panel, click only when the requested point is actually interactive, type at visual coordinates, and read text from an element snapshot subtree.

## Goals

- `activate_panel` reveals the existing managed panel without creating or switching tabs.
- `click_if_interactive` clicks only an interactive element at the requested visual point. If none is present, it returns nearby candidates without clicking them. Radius defaults to 48 and is bounded to 8–128.
- `visual_type` clicks a visual point and types text with optional replacement; `press` can optionally focus a visual point before a key chord.
- `read` accepts `scope:"element"` with an element `snapshotId` and `ref`, returning text only from that rendered subtree with the same pagination.
- Prompt, action receipts, cards, docs and real-page verification reflect the actual outcomes.

## Non-goals

- No automatic click of nearby candidates and no new browser tool or snapshot family.
- No synthetic element text from the whole document when an element scope was requested.
- No turn-end implicit release or unrelated lifecycle changes.

## Approaches

1. **Existing snapshot and control channels (selected).** Visual actions compile into the current run scope; element reads resolve `tab.ref` and evaluate within its handle; panel reveal uses a dedicated managed command.
2. **Nearest-button heuristic.** Rejected: nearest is not consent to click, so nearby elements are returned only as candidates.
3. **Renderer-only panel activation.** Rejected: Agent state must be published by the Electron main authority and visible in subsequent status.

## Verification

- Tests cover exact interactive clicks, no-click candidates, radius validation, visual typing/replacement, key focus, subtree-only text and panel state.
- Real pages prove a nearby button is not clicked, exact button is clicked, typed value is correct, element text excludes siblings, and panel visibility is published.
