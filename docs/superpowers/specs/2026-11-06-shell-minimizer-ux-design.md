# Shell Minimizer UX Design

## Intent

Make the existing native shell minimizer measurable and transparent without introducing an external RTK process. Users should be able to see how much output was minimized, inspect the lossless original, and edit all supported minimizer settings.

## Goals

- Preserve per-run filter, byte counts, and raw-artifact id in Bash tool details.
- Persist numeric savings records without commands, paths, output, credentials, or session content.
- Expose aggregate byte savings and a weighted savings percentage in Settings → Shell.
- Open a session-scoped, read-only raw-output preview from the Bash card.
- Expose existing advanced settings through the shared schema UI.

## Non-goals

- No external `rtk rewrite`, installer, updater, or version gate.
- No token-savings claim: the measured unit is bytes.
- No PTY or client-terminal minimizer behavior change.
- No second artifact browser and no changes to design-artifact panels.
- No automatic preview of another session's numeric artifact id.

## Approaches

1. **Chosen: extend the existing native result → details → RPC → renderer chain.** It preserves current execution and permission semantics and needs no dependency.
2. **Aggregate in the renderer.** Rejected because sessions and daemon restarts would lose or duplicate records, and exported/collab views cannot supply daemon persistence.
3. **Reuse the design Artifacts panel for raw output.** Rejected because it scans workspace `artifact.manifest.json` files, not session `artifact://` storage.

## Design

`executeBash` records each actual native rewrite and returns `BashMinimization { filter, inputBytes, outputBytes, artifactId? }`. `BashTool` copies that object to `details.minimization`. An append-only JSONL journal stores only timestamp, filter, input bytes, and output bytes; malformed records and non-positive savings are ignored. The summary computes `savedBytes = max(0, input-output)` and `savingsPct = 100 * saved/input` from aggregate bytes, not an unweighted mean.

`settings.shellMinimizerStats` returns the aggregate. Settings → Shell shows command count, saved bytes, weighted percentage, a native labelled `<progress>`, per-filter rows, and Refresh. Existing `settingsPath`, `only`, `except`, `maxCaptureBytes`, and `legacyFilters` settings receive UI metadata in a Bash Advanced group.

`ToolRenderHost.openArtifact?(id)` is optional. The Bash renderer shows filter and per-command percentage, and offers View raw output only when both an artifact id and host capability exist. Desktop opens a permanently mounted `DialogFrame`; it calls `session.artifactRead { sessionId, id }` with the owning session. The daemon accepts numeric ids only, resolves through that session's `SessionManager`, and returns at most 8 MiB plus `truncated` and `totalBytes`, never a filesystem path. The preview uses existing modal focus, Escape, close-button, and scroll contracts.

## Failure behavior

Journal writes are best-effort and never fail the Bash command. Missing journals are empty statistics. Missing sessions/artifacts and malformed ids fail explicitly. Unavailable preview hosts keep the numeric artifact id but hide the button. Older persisted results without `details.minimization` render as before.

## Verification

Contract tests cover journal aggregation and malformed input, real native minimization metadata, RPC content/truncation/id/session failures, Bash renderer host fallbacks, settings refresh, and dialog loading/content/error states. Focused package checks precede the real desktop scenario: a minimized Bash call exposes savings, the card opens the original output, and Shell settings refresh includes the new record.
