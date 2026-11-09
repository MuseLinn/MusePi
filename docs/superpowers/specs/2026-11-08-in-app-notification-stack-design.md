# In-app notification stack design

## Intent

Kimi Code and openchamber both expose one in-app notification surface: a transient toast with a kind icon, a message, a close affordance, and a stack that reacts to the pointer. MusePi already has most of that anatomy, but it is split across three implementations and the desktop app drops a whole class of session-level feedback.

Absorb the useful parts of the openchamber/Sonner interaction without adding a dependency or discarding the existing glass material, extension identity, or the guest/mobile shell: one store, one API, two presentation hosts, and a written contract.

## Goals

- One notification store and API exported by `@musepi/client-core`, shared by the desktop app and the client-core web/mobile shells.
- Desktop stack gains the openchamber-style interaction: collapsed overlap, hover/focus expansion, 180 ms exit, a countdown ring on the close affordance, and an optional cancel action beside the primary action.
- The desktop session store maps daemon `notice`, `auto_retry_*`, and `auto_compaction_*` events into the same stack instead of ignoring them.
- client-core session notices (`client.ts`, `host-client.ts`) write to the same store; the bottom-strip presentation stays.
- One written notification spec, plus updates to the design/implementation/extension docs and the changelog.

## Non-goals

- OS/desktop notifications (`packages/desktop-app/src/lib/notify.ts`) and their settings. They stay a separate delivery channel.
- Redesigning the OTA `UpdateToast` or its dialog layer.
- A persistent notification center, history, or unread list.
- Swipe-to-dismiss, RTL mirroring, or the mobile banner layout. The app has no RTL locale and the desktop pointer is not a swipe surface.
- New dependencies, new glass tokens, or a new z-index layer.

## Constraints

- Extension identity is frozen: `EXTENSION_HOST_MODULES` keeps the key `action-toast` with relative path `lib/action-toast`. Compiled plugins bind to the host module table, so the desktop module must keep exporting the same function names and share the store instance with `client-core`.
- The store is React-free and i18n-free. Views own timers; the store owns `expiresAt` and capacity.
- One TTL/capacity table for every host: `info` and `success` 6 s, `warning` 8 s, `error` persistent. Maximum 3 visible, evicting the oldest non-error first.
- Motion: 200 ms enter, 180 ms exit. `.gui-motion-off` and `prefers-reduced-motion` disable both. The stack must not reflow the transcript or steal focus.
- Accessibility: the stack container is the polite live region (`role="status"`, `aria-live="polite"`, `aria-atomic="false"`) and stays mounted while empty; errors carry `role="alert"` + assertive on the row; the close button is labeled; hover or focus pauses every visible timer without resuming early; the stack never steals focus.
- User-facing documentation is bilingual; the changelog entry goes under `[Unreleased]` with an inline English line.

## Approaches

1. **Desktop-only enhancement.** Keep the two stores and upgrade only `ActionToastStack`. Smallest diff, but leaves guest/mobile on a different lifecycle and duplicates every later fix.
2. **Shared store in client-core, two presentation hosts.** Move the store to `client-core`, re-export it from the desktop module, keep the desktop corner stack and the client-core bottom strip as views. No dependency, preserves glass and host-module identity, and fixes the session-notice gap once. **Chosen.**
3. **Adopt Sonner.** Quickest path to collapse/expand, swipe, and progress rings, but adds a dependency, replaces the established material, and rewrites the existing contract tests. It also does not wire desktop session events by itself. Rejected.

## Design

### Store

New authority: `packages/client-core/src/lib/action-toast.ts`, exported from `packages/client-core/src/index.ts`.

```ts
type ActionToastKind = "info" | "success" | "warning" | "error";

interface ActionToast {
  id: number;
  kind: ActionToastKind;
  message: string;
  title?: string;
  details?: string;
  dedupeKey?: string;
  actionLabel?: string;
  onAction?(): void;
  cancelLabel?: string;
  onCancel?(): void;
  expiresAt: number;
}
```

The existing semantics move unchanged: repeated sources replace their earlier content, `dismissActionToastSource(key)` clears one recovered source, errors persist and are evicted last, `pauseActionToast` / `resumeActionToast` freeze the remainder. `MAX_ACTION_TOASTS` stays 3. `ttlFor(kind)` replaces the single 6 s constant so the desktop and guest shells share one table.

`packages/desktop-app/src/lib/action-toast.ts` becomes a pure re-export of the client-core module. Every current import path, the host-module table entry, and `host-modules.test.ts` keep working; the store instance is now the same one the guest shell uses.

### Desktop stack

`ActionToastStack` subscribes to the shared store.

- **Collapsed stack.** The container carries `data-expanded`. At rest, older toasts sit behind the newest: each older item translates upward by 8 px and scales down by 0.04; its content drops to zero opacity so only a sliver shows. Pointer entry or keyboard focus expands the stack to the normal 8 px column, and leaving collapses it again. With one toast the stack is always expanded.
- **Exit.** A local `leaving` map keeps an item mounted for 180 ms after a user-initiated close, action, or timer expiry, so `.gui-action-toast--closing` can play. Source dismissal (`dismissActionToastSource`) is a recovery signal and removes the item without an exit animation.
- **Countdown ring.** The close affordance gains a 16 px SVG ring whose `stroke-dashoffset` runs from full to empty over the remaining lifetime. Hover or focus freezes the offset; resuming restarts the ring from the frozen fraction with the remaining duration. Errors render no ring.
- **Cancel.** `cancelLabel` renders a secondary text button before `actionLabel`; it calls `onCancel` and dismisses.
- **Motion.** Enter stays 200 ms `translateY(8px)`; exit is 180 ms `translateY(6px)` + fade. Reduced motion and `.gui-motion-off` remove both.

The stack remains inside `.gui-toast-corner` (z 910) beside `UpdateToast`; no layering change.

### Desktop session events

`GuiSessionStore`'s agent-event switch gains the events it currently drops:

| Event | Toast |
| --- | --- |
| `notice` | `kind = level`, message as-is, `dedupeKey = session:notice:<source ?? "daemon">` |
| `auto_retry_start` | `info`, `sessions.retryWithAttemptWithMaxWithReason`, `dedupeKey = session:retry` |
| `auto_retry_end` success | `dismissActionToastSource("session:retry")` |
| `auto_retry_end` failure | `error`, `sessions.retryFailed` or `finalError`, same key |
| `auto_compaction_start` | `info`, `sessions.compactingContextWithReason`, `dedupeKey = session:compaction` |
| `auto_compaction_end` skipped | `dismissActionToastSource("session:compaction")` |
| `auto_compaction_end` otherwise | `info` or `error`, aborted/failed/succeeded message, same key |

The mapping lives in a pure `src/lib/session-notice.ts` helper returning an `ActionToastInput` or a dismiss key, so the switch stays thin and the mapping is unit-testable. These events do not fire OS notifications; that channel stays with `notify.ts`.

### client-core session notices

`SessionClient.#pushNotice` and `HostClient.#pushNotice` delegate to `pushActionToast` with `kind = level` and the existing message. The `Notice` interface and the `notices` snapshot field are removed: they existed only to feed `Toasts.tsx`, and keeping both would make the store and the snapshot disagree after a pause or dedupe.

`Toasts` becomes a store subscriber with the same `.sh-toasts` bottom strip. It keeps the existing 8 px column, hover/focus pause, and close button, but expiry and capacity now come from the shared store. `client-core/src/app.tsx` mounts `<Toasts />` without the client prop.

### Documentation

- New `docs/gui-notification-spec.md` and `docs/gui-notification-spec.zh-CN.md`: API shape, kind semantics, TTL, dedupe, capacity, placement, stack interaction, accessibility, extension entry points, and the boundary against OS notifications.
- `docs/gui-design.md` §5x and `docs/gui-implementation.md` §45.3 gain the stack interaction, the ring/cancel parts, and the shared-store ownership; their Chinese pairs stay in sync.
- `docs/extensions-dev.md` / `.zh-CN.md`: `action-toast` now resolves to the client-core store through the desktop re-export.
- `packages/coding-agent/CHANGELOG.musepi.md` under `[Unreleased]` with an English line.

### Verification

- Store and view contracts: `bun test packages/client-core/test/action-toast.test.ts packages/client-core/test/toasts.test.tsx packages/desktop-app/test/action-toast.test.ts packages/desktop-app/test/session-store.test.ts packages/desktop-app/test/host-modules.test.ts`.
- Type and lint gates: `bun --cwd=packages/client-core run check` and `bun --cwd=packages/desktop-app run check`.
- Repository gates touching the change: `bun check:docs`, `bun check:changelog-i18n`, `bun check:css-structure`, `bun check:glass-backdrop`.
- Manual desktop pass: session notice / failed retry appears in the corner stack; hovering expands a 3-toast stack; close plays the exit and the ring freezes on hover; a cancel action runs before dismissal; guest web shell still shows the bottom strip.

## Decisions left to the builder

- Exact collapsed offsets and scale step (8 px / 0.04 is the starting point; tune against the 420 px max width).
- Whether the ring uses a 1.5 px stroke and how the close glyph shares the disc with it.
- Whether `notice` toasts need a title from `source`; the default is message-only.
