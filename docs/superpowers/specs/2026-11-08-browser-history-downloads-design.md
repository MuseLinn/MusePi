# Browser history and download records

## Intent

Adopt the Kimi Code retained-record mechanism for the managed browser. The Agent and user can inspect actual history and downloads across conversations in the current application profile without reading page contents or relying on the currently open tabs.

## Goals

- Record committed managed-tab navigations, newest first, bounded to 200 history entries.
- Record managed-partition downloads from destination selection through progress and settlement, newest first, bounded to 100 entries.
- Persist records in the Electron profile so window/conversation replacement does not erase them. URLs are credential-redacted; times are Unix milliseconds and sizes are bytes.
- Expose `/musepi/history` and `/musepi/downloads` through the existing loopback authority, plus `history`/`downloads` actions in the existing browser tool and matching cards.
- Download records include status, received/total bytes, and optional `savePath`; a recorded path does not claim the file still exists.

## Non-goals

- No history/download querying in headless mode as a fabricated empty success. Without the managed Electron authority the action returns an explicit error.
- No page text, cookies, request headers, or arbitrary file reads.
- No clear-data behavior change and no second browser channel.

## Approaches

1. **Main-process record store (selected).** A focused CJS store persists bounded records; `ManagedBrowserController` writes lifecycle events and serves loopback reads, while coding-agent projects the same records.
2. **Derive from open tabs.** Rejected: closed tabs and completed downloads disappear, so this cannot satisfy retained history.
3. **Renderer-owned records.** Rejected: the Agent needs a main-process authority that survives renderer/conversation changes and cannot be replaced by a stale projection.

## Verification

- Store tests cover persistence, newest-first ordering, caps, malformed files, and optional paths.
- Controller tests cover real navigation records and download progress/settlement plus loopback responses.
- Tool/card tests cover projected fields and managed-only failure behavior.
- An isolated controller/HTTP scenario proves records survive a new controller and are returned newest first.
