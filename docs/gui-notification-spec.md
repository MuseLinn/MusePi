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

Kinds drive the leading icon colour and nothing else — the card, border and shadow stay identical in every kind, because a tinted surface competes with the message it carries:

- `info` — neutral notice (information icon, muted);
- `success` — completed action (check, success colour);
- `warning` — condition to fix (alert, warning colour);
- `error` — failure that persists until dismissed (error colour, assertive announcement).

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

## 4. Placement and size

**Desktop.** `.gui-toast-corner` is fixed at the bottom-right (20 px inset, z 910) and holds `UpdateToast` plus `ActionToastStack`. The OTA card keeps its own z-index within that column.

**Guest/mobile.** `.sh-toasts` is a bottom strip (fixed, z 60, right-aligned).

Both shells render the same card:

| Property | Value |
| --- | --- |
| Width | 320 px fixed, `calc(100vw - 32px)` ceiling |
| Padding | 12 / 14 px on desktop, 10 / 12 px on mobile |
| Icon-to-text gap | 10 px |
| Radius and border | `--radius-lg`, 1 px `--glass-border` |
| Surface | `--glass-sheen` over `--glass-bg-strong`, `backdrop-filter: blur(--gui-glass-blur) saturate(1.4)`, `--glass-shadow` |
| Icon | 15 px, first-line aligned, the ONLY element carrying the kind colour |
| Title / message | `--ui-font-size-sm`, 600 / 400, line-height 1.35 / 1.45 |
| Close | a bare 18 px glyph — no badge or secondary label; a self-closing toast also carries the countdown ring around it |

**Height ceiling.** A card never grows past one third of the window: `calc((100dvh - 40px - 16px) / 3)` on desktop (the corner's 20 px insets plus the two 8 px stack gaps) and the same split of the strip between the safe-area insets on guest/mobile. A longer message scrolls inside the card body (`overflow-y: auto`, `overscroll-behavior: contain`); nothing is clamped, line-limited or clipped, and the close button stays visible.

Stack behaviour:

- **Never collapsed.** A row always keeps its full height, up to the ceiling above; past that its body scrolls instead of the row shrinking. Three rows is the store cap, and a fourth evicts the oldest non-error; clipping siblings to slivers hides messages the user has not read yet.
- **Exit:** user-initiated close, action, and cancel keep the row mounted for 180 ms with `gui-action-toast--closing` (fade + 6 px down). Source recovery removes the row without an exit.
- **Countdown ring:** a toast that closes by itself draws a 16 px ring around its close affordance, full when it appears and empty when it goes; a persistent error has no lifetime, so it carries none. Pointer entry or keyboard focus freezes it with the timers it mirrors, and leaving resumes it from the frozen point.
- **Pause:** pointer entry or keyboard focus anywhere in the stack freezes every timer; leaving resumes each remainder.
- **Cancel:** `cancelLabel` renders as a secondary text button before the primary action; it runs `onCancel` and then dismisses.

Motion is 200 ms in and 180 ms out. `.gui-motion-off` and `prefers-reduced-motion: reduce` disable both, and reduced motion also hides the ring.

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
