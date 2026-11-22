---
layout: default
title: GUI context, session hierarchy, and role models
status: living
summary: Structured quote contexts, session subtree collapse, host-owned session read state, and per-role/fallback thinking-level contracts.
scope:
  - packages/client-core/src/messages
  - apps/desktop/src/components
  - packages/coding-agent/src/session
  - packages/coding-agent/src/daemon
---

# GUI context, session hierarchy, and role models

English | [中文](gui-context-and-session.zh-CN.md)

This document owns four related GUI contracts that were previously appended to the general GUI specs: structured context cards, session subtree collapse, session read state, and role/fallback thinking levels.

## Structured display context

`DisplayContext` is message-level presentation metadata. The model-facing text and the UI are derived from the same value; display metadata never selects model behavior.

Variants:

- `browser-annotation`: page URL, prompt, optional comment and screenshot.
- `chat-quote`: quoted message text, optional source message id and comment.
- `file-quote`: workspace path, selected text, optional language, line range and comment. An empty quote means a whole-file reference and sends only the path.

`composeDisplayContextPrompt` produces model text. Immediate send, working steer/followUp, queue, queued pop/send, optimistic echo, and persistence preserve the structured value alongside that text. Ordinary Markdown blockquotes are not contexts.

Composer chips expose source, preview, removal, and comment editing. Input is preserved verbatim while editing, including spaces and newlines; leading/trailing whitespace is trimmed only when the model prompt is composed. Browser annotation prompts without a `Comment:` line remain byte-identical.

The transcript renders a dedicated source card with a left rail, clamped quote, expansion, comment, and source-message jump when available. It never reparses an ordinary blockquote into that card.

### File and code references

FilePane's quote action emits `file-quote` rather than inserting `@path` into the draft. A selection inside the preview carries its text; without a selection the action references the whole file. `data-file-path` and `data-file-language` provide source identity for both the button and Cmd/Ctrl+L.

Line numbers are emitted only when the selection maps uniquely back to the source. Duplicate or unmappable text keeps the path without a fabricated range. The quote button prevents pointer-down from destroying the active selection.

## Session subtree collapse

A collapsed parent remains visible and represents its hidden descendants. Only child rows animate height; the parent never receives a zero-height leaving animation. Expanding restores the original children, and remounting is not required.

The shared subtree store coordinates every `SessionList` instance and persists collapsed ids. Search temporarily expands matching paths. A collapsed row uses a separate fold control inside a keyboard-operable row container, never a nested `<button>`.

The header's global action coordinates projects and subtrees:

- `setGroupsAll` takes `open`, while `setAllSubtreesCollapsed` takes `collapse`.
- With no group override (`groupsAll === null`), the actual subtree state determines the next action.
- Each tab applies its project/group state and then calls `setAllSubtreesCollapsed` in the same direction.

## Session read state

The daemon owns whether a session is unread or failed. `SessionReadStateService` holds one record per session on the host and persists it to `session-read-state.json` in the daemon state directory with tmp+rename, so the markers survive a daemon restart and every client connected to the same host renders the same answer: reading a session on the phone clears the desktop dot, and a cleared failure notice does not come back on relaunch. Forks, subagent sessions and advisor sessions are separate session ids and therefore separate records; clients filter which rows they show.

A record counts **completed turns**, not messages:

| Field | Meaning |
| --- | --- |
| `completedTurn` | Monotonic count of finished agent runs observed on this host. |
| `readTurn` | `completedTurn` value the user last read up to. |
| `lastFailed` | Whether the most recent completed turn ended in an error. |
| `manualUnread` | The user pinned the session unread; only an explicit read clears it. |

Derived state is `unread = manualUnread || completedTurn > readTurn`, and `failed = unread && lastFailed`. A failure notice therefore only exists while the failed turn is still unread: reading the session clears it, a later successful completion clears it, and an abort is the user's decision rather than a failure notice. A completion of a session that a client is currently subscribed to advances `readTurn` (the transcript is on screen), but never clears `manualUnread` — a pinned session stays unread until an explicit read.

Clients never derive unread from message counts. `session.list` rows carry `read` (`unread`, `failed`, `manualUnread`, the counters and `completedAt`), and `sessionStatus.list` returns the tracked set. Opening a session sends `sessionStatus.mark { sessionId, read: true }`, which clears the pin and catches up to the latest completed turn; the sidebar menu's 标记为已读/未读 sends the same route with `unread: true` to pin. `sessionStatus.markAll` reads every tracked session plus the ids the caller lists, and the welcome reminders panel and the pet badge consume the `unread` set projected from the poll. Approving a pet bubble's ✓ is the same explicit read. Sessions without a record have never completed a turn on this host and read as read.

The retired localStorage cursors (`musepi-gui-unread`, `musepi-gui-read-count`) no longer exist. On the first launch after the upgrade every existing session is already read, because the host starts with no completed turns recorded; the old keys are removed rather than interpreted.

The desktop sidebar draws an accent dot for a plain unread row and a danger dot for an unread failure; the two markers are exclusive (a failed row drops the accent class), and the failure marker carries an accessible label. The mobile `SessionsSheet` reads the same state and uses the same accent/danger split on its leading dot. Neither surface renders a failure from the session's persisted lifecycle status: lifecycle may describe an older turn, while the read state always describes the latest completed one.

## Withdraw (撤回)

Withdrawing a turn is a branch move, not a deletion: `session.branchAt` moves the session leaf to the message's parent, so the turn leaves the active path and stays on the tree as a sibling branch. The abandoned turn is therefore still reachable from the map and the message tree — that is the point, and it is not a bug.

The user-visible contract:

- **It asks first.** Every action that moves the leaf off the end of the conversation asks the same question: the transcript row's ⤺ action and its *edit and resend* sibling, the message-tree panel row, the map's re-answer, and the panel's turn re-answer. Switching to another branch is navigation and moves the leaf the same way, but it is how the user reads a side branch, so it does not ask. The question names the turn (its prompt, or "an earlier turn" when the row carries no content the client can read) and states the consequence in product words: the turn moves to a side branch, nothing is deleted, its text and pictures return to the composer, and the dock offers one undo. A running turn is named in the same question — "the reply still being written stops when you withdraw" — rather than as a second interrupt dialog asked first and a "are you sure" asked after it; the stop happens after the answer. Cancelling returns before any RPC, so the leaf does not move.
- **The transcript follows the active path.** After a withdraw it shows the conversation up to and including the withdraw target and nothing from the abandoned tail. The dock above the composer names the target and offers a single undo, which branches back and restores the turn.
- **One precedence rule, not a special case.** When the daemon has answered a `branchAt` (or broadcast `session_leaf_moved`), its path is authoritative and decides transcript visibility; the local `parentId` walk is a fallback for sessions that were never rewound in the loaded window. This is stated once, here and in `leaf-walk.ts`, because a `parentId` cut is legal on the wire (`packages/wire/src/index.ts:173`) — the normal shape after a rewind, not an edge case. A tail whose links are all missing is indistinguishable from a session root run, so the walk answers `complete: true` while describing the wrong path; that is exactly why it cannot be trusted over the daemon's answer.
- **That authority is a window, not the whole path.** The daemon answers with at most the last 200 entries (`daemon/server.ts` slices `pathEntries` to `TAIL_ENTRIES`), while the client keeps every page it loaded. So the daemon path decides only from its first id onward; rows older than that fall back to the walk, which hides nothing when its chain is untrusted. Making the projection unconditional deleted real history on any session with more than 200 loaded rows the moment a withdraw pinned it. The daemon path also carries messages only, so a compaction divider the walk places on the active path stays visible even though the set does not list it.
- **The authority ends when the user writes again.** A new prompt commits the branch and drops the pinned path, after which the walk follows the tip again. Keeping the old path would invert the bug: the transcript would hide the answer just asked for. The daemon broadcasts the new path when the run starts.
- **Off-path turns are marked as data.** `TrajectoryTurnGroup.offPath` is `true` for a turn whose first event sits off the active path, and `undefined` when no path is known — absence only means something when a path exists. The map's visual treatment of that fact is its own concern.

## Role and fallback thinking levels

Role values use `provider/id:level`, including `:auto`. `auto` is a per-role policy, not a global default and not an effort rung. It is preserved by model clamping; unsupported concrete levels fall back to `inherit`, while `off` and `auto` remain valid.

Role rows offer `inherit`, `auto`, `off`, and the resolved model's concrete efforts. Each fallback row has the same independent selector, but its ladder comes from `models.detail` for that exact selector. Changing one fallback entry replaces only its suffix and leaves the primary role and other entries unchanged.
