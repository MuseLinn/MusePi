# Browser dialogs and tab-control design

## Intent

Add structured dialog evidence and explicit tab-control actions while preserving existing tab ownership and close semantics. Pending dialogs must be visible to the Agent and user; releasing Agent control must not close the page.

## Goals

- `dialog` returns pending dialogs with id, tab, kind, message, default value and age. Run results also include pending/handled dialogs where observed.
- `dialog_respond` accepts or dismisses the pending dialog and records actor, outcome and prompt text. Auto-policy and navigation settlement are recorded rather than hidden.
- `activate` selects an existing/adopted control target without revealing it; `switch` also activates its real target in the managed panel; `release` detaches control without closing the page.
- `status` includes pending dialogs. Control release clears the managed `agentTabId` so status cannot claim stale control.
- Prompt and user cards reflect pending/handled dialogs and control results.

## Non-goals

- No change to existing `close`, auto-dialog policy, upload-confirmation flow, or user-takeover lifecycle.
- No implicit turn-end release in this phase; release is an explicit action.
- No claim of full protocol parity until history/devices and remaining visual operations land.

## Approaches

1. **Extend worker and target contracts (selected).** Stream dialog state through the existing worker/supervisor and add control actions to the existing tool. Use a detach path distinct from close.
2. **Renderer-only dialog text.** Rejected: it cannot answer the actual page dialog or prove control state.
3. **Treat close as release.** Rejected: it destroys the page and contradicts the reference lifecycle.

## Verification

- Unit tests cover dialog response, auto-handling, missing-dialog errors, and detach preserving the target.
- Host tests cover managed control clearing and stale-status prevention.
- A real page opens alert/prompt dialogs; Agent reads and answers them. A managed target is activated, switched and released without closing the page.
