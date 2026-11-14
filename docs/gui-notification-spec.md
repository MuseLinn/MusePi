---
layout: default
title: In-app notification contracts
status: living
summary: API, lifetime, placement, stack interaction, and accessibility for MusePi's in-app notification stack.
scope:
  - packages/client-core
  - apps/desktop
---

# In-app notification spec

English | [中文](gui-notification-spec.zh-CN.md)

Status: current contract. Implementation lives in `packages/client-core/src/lib/action-toast.ts` (store), `apps/desktop/src/components/ActionToast.tsx` (desktop view), and `packages/client-core/src/components/shell/Toasts.tsx` (guest/mobile view).

## 1. What this surface owns

The in-app notification stack is the single home for transient, app-initiated feedback: action results, undo offers, session-level daemon notices, and errors that are not connection banners.

It is not:

- the OTA update card (`UpdateToast` / `UpdateDialog`), which shares the desktop corner but keeps its own state;
- an OS notification (`apps/desktop/src/lib/notify.ts`, Settings → 通知与音效);
- a persistent notification center or history. When a toast leaves, it is gone.

## 2. API

The store is React-free and i18n-free. Views own timers; the store owns `expiresAt`, replacement, and capacity.

| Export | Contract |
| --- | --- |
| `pushActionToast(input): number` | Add one toast. Repeated `dedupeKey` replaces the earlier content from that source. Returns the id. |
| `dismissActionToast(id)` | Remove one by id; unknown ids are no-ops. |
| `dismissActionToastSource(dedupeKey)` | Remove only the toasts from one recovered source. |
| `pauseActionToast(id)` / `resumeActionToast(id)` | Freeze and continue the remaining lifetime; idempotent. |
| `getToasts()` / `subscribeActionToasts(fn)` | Read the immutable list / subscribe to changes. |
| `ttlFor(kind)` | Lifetime for one kind. |

`ActionToastInput` fields: `kind`, `message`, optional `title`, `details`, `dedupeKey`, `actionLabel` + `onAction`, `cancelLabel` + `onCancel`.

Kinds drive the leading icon and the tint only; the glass surface stays neutral:

- `info` — neutral notice (information icon, muted);
- `success` — completed action (check, success color);
- `warning` — condition to fix (alert, warning tint on icon and border);
- `error` — failure that persists until dismissed (error tint, assertive announcement).

| Kind | Lifetime |
| --- | --- |
| `info`, `success` | 6000 ms |
| `warning` | 8000 ms |
| `error` | Never expires |

Capacity is 3. A fourth toast evicts the oldest non-error first; persistent errors are evicted only when the stack is all errors.

## 3. Entry points

- **Direct import** — any pane calls `pushActionToast`; both shells re-export the same store.
- **`musepi-gui-toast`** — a `CustomEvent` on `window`. `detail` is either a string or an `ActionToastInput`-shaped object. Missing `kind` defaults to `error`, preserving the old error-banner semantics for callers that only pass a message.
- **Extensions** — compiled plugins bind `lib/action-toast` to `window.MusePiHostModules["action-toast"]`, so a plugin and the host share one list.
- **Daemon session events** — the desktop session store maps events through `apps/desktop/src/lib/session-notice.ts`:

| Event | Result |
| --- | --- |
| `notice` | Toast with the event's level; `dedupeKey = session:notice:<source \|\| daemon>` |
| `auto_retry_start` | Info, `session:retry` |
| `auto_retry_end` success | Dismiss `session:retry` |
| `auto_retry_end` failure | Error, `session:retry` |
| `auto_compaction_start` | Info, `session:compaction` |
| `auto_compaction_end` skipped | Dismiss `session:compaction` |
| `auto_compaction_end` aborted / failed / completed | Info or error, `session:compaction` |

Retry and compaction reuse one source key so the stack shows the latest step instead of piling up progress rows.

## 4. Placement and stack interaction

**Desktop.** `.gui-toast-corner` is fixed at the bottom-right (20 px inset, z 910) and holds `UpdateToast` plus `ActionToastStack`. The OTA card keeps its own z-index within that column.

**Guest/mobile.** `.sh-toasts` is a bottom strip (fixed, z 60, right-aligned, max 320 px).

Desktop stack behavior:

- **Collapsed:** with two or more toasts, only the newest is fully legible. Older rows clip to a 10 px bar at reduced opacity. The newest carries `gui-action-toast--front`.
- **Expanded:** pointer entry or keyboard focus expands the column to the normal 8 px gap. Leaving collapses it again. A single toast is always expanded.
- **Focus reachability:** collapsed peers keep their buttons in the tab order; focusing any control expands the stack before the next Tab lands.
- **Exit:** user-initiated close, action, and cancel keep the row mounted for 180 ms with `gui-action-toast--closing` (fade + 6 px down). Source recovery removes the row without an exit.
- **Countdown ring:** the close affordance carries a 16 px ring that empties over the remaining lifetime. Hover or focus freezes it; resuming continues from the frozen point. Errors have no ring.
- **Cancel:** `cancelLabel` renders as a secondary text button before the primary action; it runs `onCancel` and then dismisses.

Motion is 200 ms in and 180 ms out. `.gui-motion-off` and `prefers-reduced-motion: reduce` disable the enter, exit, ring, and collapse transitions.

## 5. Accessibility

- Errors use `role="alert"` and `aria-live="assertive"` on the row.
- The stack container is the polite live region (`role="status"`, `aria-live="polite"`, `aria-atomic="false"`) and stays mounted even when empty, so the first status toast is announced. Non-error rows carry no role of their own.
- The close button has a localized `aria-label`/`title`; action and cancel buttons are real `<button>` elements.
- Hover or focus anywhere in the stack pauses every visible timer (not only the row under the pointer); leaving resumes each remainder. The stack never steals focus.
- Collapsed rows remain reachable; expansion is a visual change, not an `aria-hidden` change.

## 6. Boundaries

- No swipe-to-dismiss, RTL mirroring, mobile banner layout, or notification history. The app has no RTL locale and the desktop pointer is not a swipe surface.
- The OTA `UpdateToast` is not part of this store: it has its own progress/restart state and “revive” behavior.
- OS notifications and their templates remain in `notify.ts` and Settings → 通知与音效.
