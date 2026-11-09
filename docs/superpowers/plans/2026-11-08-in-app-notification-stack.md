# In-App Notification Stack Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One in-app notification store shared by the desktop and guest/mobile shells, with openchamber-style stack interaction on desktop and session-level daemon notices wired into it.

**Architecture:** Move the action-toast store from `packages/desktop-app` into `packages/client-core` and re-export it from the desktop module so the extension host-module identity stays fixed. Both shells subscribe to that store with their existing presentation (desktop corner glass stack, guest bottom strip). The desktop session store maps `notice` / retry / compaction events through a pure helper into the same store.

**Tech Stack:** TypeScript, React 19, Bun test, happy-dom, Biome/tsgo, existing glass CSS tokens.

**Spec:** `docs/superpowers/specs/2026-11-08-in-app-notification-stack-design.md`

## Global Constraints

- Host-module identity is frozen: key `action-toast`, relative path `lib/action-toast`, same function names.
- Store is React-free and i18n-free; views own timers.
- TTL table: `info`/`success` 6000 ms, `warning` 8000 ms, `error` `Number.POSITIVE_INFINITY`. `MAX_ACTION_TOASTS = 3`.
- Desktop motion: 200 ms enter, 180 ms exit; `.gui-motion-off` and `prefers-reduced-motion` disable both.
- Accessibility: error = `role="alert"` + `aria-live="assertive"`; others `role="status"` + `aria-live="polite"`; close button labeled; hover/focus pauses without resuming early.
- User-facing docs are bilingual; changelog goes under `[Unreleased]` with an inline English line.
- No new dependencies and no new glass tokens.

## Review Focus

- **Same message, different sources.** A dedupe key must keep two sources distinct; only the default message key may replace. Task 1 pins it.
- **Paused toast lifetime.** Hovering at 3 s and advancing 10 s must not remove it; leaving must use the remaining time. Task 2 pins it in the guest view; Task 4 in the desktop view.
- **Error floods.** Three persistent errors must all survive a fourth transient toast, and a new error must evict a transient before an error. Task 1 pins it.
- **Stale timer.** A timer for a dismissed toast must not dismiss a newer toast. Task 4 keeps timer callbacks keyed by id and Task 1 keeps ids monotonic.
- **Keyboard reachability in a collapsed stack.** Focusing any control must expand the stack, and collapsed peers must not become untabbable. Task 4 pins the expanded attribute and the exit class.

---

### Task 1: Move the store into client-core and add the TTL/cancel contract

**Files:**
- Create: `packages/client-core/src/lib/action-toast.ts`
- Modify: `packages/client-core/src/index.ts`
- Modify: `packages/desktop-app/src/lib/action-toast.ts`
- Create: `packages/client-core/test/action-toast.test.ts`
- Modify: `packages/desktop-app/test/action-toast.test.ts` (store imports only; view tests stay)

**Interfaces:**
- Produces: `ActionToastKind`, `ActionToast` (with `cancelLabel?`, `onCancel?`), `ActionToastInput`, `ACTION_TOAST_TTL_MS`, `WARNING_TOAST_TTL_MS`, `MAX_ACTION_TOASTS`, `ttlFor(kind): number`, `getToasts()`, `pushActionToast(input): number`, `pauseActionToast(id)`, `resumeActionToast(id)`, `dismissActionToast(id)`, `dismissActionToastSource(dedupeKey)`, `subscribeActionToasts(listener)`.
- Consumes: nothing from earlier tasks.

- [ ] **Step 1: Write the failing store test**

Create `packages/client-core/test/action-toast.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import {
  ACTION_TOAST_TTL_MS,
  WARNING_TOAST_TTL_MS,
  dismissActionToast,
  dismissActionToastSource,
  getToasts,
  pauseActionToast,
  pushActionToast,
  resumeActionToast,
  ttlFor,
} from "../src/lib/action-toast";

afterEach(() => {
  for (const toast of getToasts()) dismissActionToast(toast.id);
  setSystemTime();
});

beforeEach(() => setSystemTime(20_000));

describe("action toast store", () => {
  test("kind owns the lifetime, errors never expire", () => {
    expect(ttlFor("info")).toBe(ACTION_TOAST_TTL_MS);
    expect(ttlFor("success")).toBe(ACTION_TOAST_TTL_MS);
    expect(ttlFor("warning")).toBe(WARNING_TOAST_TTL_MS);
    expect(ttlFor("error")).toBe(Number.POSITIVE_INFINITY);
    pushActionToast({ kind: "warning", message: "w" });
    expect(getToasts()[0]?.expiresAt).toBe(20_000 + WARNING_TOAST_TTL_MS);
    pushActionToast({ kind: "error", message: "e" });
    expect(getToasts().at(-1)?.expiresAt).toBe(Number.POSITIVE_INFINITY);
  });

  test("the same message from different sources coexists", () => {
    pushActionToast({ message: "保存失败", dedupeKey: "file:save" });
    pushActionToast({ message: "保存失败", dedupeKey: "market:save" });
    expect(getToasts().map(t => t.message)).toEqual(["保存失败", "保存失败"]);
  });

  test("the same source replaces its content instead of stacking", () => {
    pushActionToast({ message: "下载中", dedupeKey: "update" });
    pushActionToast({ message: "已下载", dedupeKey: "update" });
    expect(getToasts()).toHaveLength(1);
    expect(getToasts()[0]?.message).toBe("已下载");
  });

  test("three errors survive a transient and a new error evicts the transient first", () => {
    pushActionToast({ kind: "error", message: "e1", dedupeKey: "e1" });
    pushActionToast({ kind: "error", message: "e2", dedupeKey: "e2" });
    pushActionToast({ message: "t1", dedupeKey: "t1" });
    pushActionToast({ kind: "error", message: "e3", dedupeKey: "e3" });
    expect(getToasts().map(t => t.message)).toEqual(["e1", "e2", "e3"]);
  });

  test("pause freezes the remainder and resume continues from it", () => {
    const id = pushActionToast({ message: "paused" });
    setSystemTime(23_000);
    pauseActionToast(id);
    expect(getToasts()[0]?.expiresAt).toBe(Number.POSITIVE_INFINITY);
    setSystemTime(40_000);
    resumeActionToast(id);
    expect(getToasts()[0]?.expiresAt).toBe(43_000);
  });

  test("source recovery dismisses only that source", () => {
    pushActionToast({ kind: "error", message: "a", dedupeKey: "a" });
    pushActionToast({ kind: "error", message: "b", dedupeKey: "b" });
    dismissActionToastSource("a");
    expect(getToasts().map(t => t.message)).toEqual(["b"]);
  });

  test("cancel copy travels with the toast", () => {
    let cancelled = 0;
    pushActionToast({ message: "retry?", cancelLabel: "取消", onCancel: () => cancelled++ });
    expect(getToasts()[0]?.cancelLabel).toBe("取消");
    getToasts()[0]?.onCancel?.();
    expect(cancelled).toBe(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test packages/client-core/test/action-toast.test.ts`
Expected: FAIL — cannot resolve `../src/lib/action-toast`.

- [ ] **Step 3: Create the shared store**

Move `packages/desktop-app/src/lib/action-toast.ts` to `packages/client-core/src/lib/action-toast.ts` unchanged, then:

- Add `export const WARNING_TOAST_TTL_MS = 8000;` and keep `ACTION_TOAST_TTL_MS = 6000`.
- Add `cancelLabel?: string` and `onCancel?(): void` to `ActionToast`.
- Add `export function ttlFor(kind: ActionToastKind): number` returning `Number.POSITIVE_INFINITY` for `error`, `WARNING_TOAST_TTL_MS` for `warning`, else `ACTION_TOAST_TTL_MS`.
- Replace the `expiresAt` expression with `Date.now() + ttlFor(kind)`.

- [ ] **Step 4: Export from client-core and re-export from desktop**

Add to `packages/client-core/src/index.ts`:

```ts
export {
  ACTION_TOAST_TTL_MS,
  MAX_ACTION_TOASTS,
  WARNING_TOAST_TTL_MS,
  type ActionToast,
  type ActionToastInput,
  type ActionToastKind,
  dismissActionToast,
  dismissActionToastSource,
  getToasts,
  pauseActionToast,
  pushActionToast,
  resumeActionToast,
  subscribeActionToasts,
  ttlFor,
} from "./lib/action-toast";
```

Replace `packages/desktop-app/src/lib/action-toast.ts` with explicit re-exports of the same names from `@musepi/client-core` (no local state, no duplicated JSDoc). Keep the file so `lib/action-toast` path resolution in `EXTENSION_HOST_MODULES` and every existing import still resolves.

- [ ] **Step 5: Point the desktop tests at the shared store**

In `packages/desktop-app/test/action-toast.test.ts`, change the store import to `@musepi/client-core`; keep `ActionToastStack` from `../src/components/ActionToast`. Delete the moved store assertions from this file, keeping only the view tests.

- [ ] **Step 6: Run both test files**

Run: `bun test packages/client-core/test/action-toast.test.ts packages/desktop-app/test/action-toast.test.ts`
Expected: PASS.

- [ ] **Step 7: Type-check both packages**

Run: `bun --cwd=packages/client-core run check:types` and `bun --cwd=packages/desktop-app run check:types`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/client-core/src/lib/action-toast.ts packages/client-core/src/index.ts packages/client-core/test/action-toast.test.ts packages/desktop-app/src/lib/action-toast.ts packages/desktop-app/test/action-toast.test.ts
git commit -m "refactor: share the in-app toast store through client-core"
```

---

### Task 2: Route client-core session notices through the shared store

**Files:**
- Modify: `packages/client-core/src/lib/client.ts`
- Modify: `packages/client-core/src/lib/host-client.ts`
- Modify: `packages/client-core/src/components/shell/Toasts.tsx`
- Modify: `packages/client-core/src/app.tsx:839`
- Modify: `packages/client-core/test/toasts.test.tsx`
- Modify: `packages/client-core/src/lib/host-client.test.ts:253-263`

**Interfaces:**
- Consumes: `pushActionToast`, `pauseActionToast`, `resumeActionToast`, `dismissActionToast`, `subscribeActionToasts`, `getToasts`, `ttlFor` from Task 1.
- Produces: `<Toasts />` with no props; `SessionSnapshot` no longer carries `notices`; `Notice` is removed.

- [ ] **Step 1: Rewrite the Toasts view test against the store**

Replace `packages/client-core/test/toasts.test.tsx` with a test that renders `<Toasts />` and pushes into the store:

```tsx
import { afterAll, afterEach, beforeEach, describe, expect, setSystemTime, test, vi } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Toasts } from "../src/components/shell/Toasts";
import { dismissActionToast, getToasts, pushActionToast } from "../src/lib/action-toast";

GlobalRegistrator.register();
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
afterAll(() => void GlobalRegistrator.unregister());

const roots: Root[] = [];
function mount(): void {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  act(() => root.render(<Toasts />));
}
function toast(level: "info" | "warning" | "error"): HTMLElement {
  const element = document.querySelector<HTMLElement>(`.sh-toast-${level}`);
  if (!element) throw new Error(`${level} toast did not render`);
  return element;
}
function hover(element: HTMLElement, entering: boolean): void {
  act(() => {
    element.dispatchEvent(
      new MouseEvent(entering ? "mouseover" : "mouseout", {
        bubbles: true,
        relatedTarget: entering ? null : document.body,
      }),
    );
  });
}
function advance(ms: number): void {
  const startedAt = Date.now();
  act(() => {
    vi.advanceTimersByTime(ms);
    setSystemTime(startedAt + ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  setSystemTime(20_000);
});
afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root) act(() => root.unmount());
  }
  for (const item of getToasts()) dismissActionToast(item.id);
  document.body.innerHTML = "";
  vi.useRealTimers();
  setSystemTime();
});

describe("Toasts", () => {
  test("renders store content in the bottom strip", () => {
    mount();
    act(() => void pushActionToast({ kind: "info", message: "上下文已压缩" }));
    expect(toast("info").textContent).toContain("上下文已压缩");
  });

  test("hover preserves the remaining lifetime until the pointer leaves", () => {
    mount();
    act(() => void pushActionToast({ message: "6s" }));
    advance(3000);
    hover(toast("info"), true);
    advance(10_000);
    expect(document.querySelector(".sh-toast-info")).not.toBeNull();
    hover(toast("info"), false);
    advance(3000);
    expect(document.querySelector(".sh-toast-info")).toBeNull();
  });

  test("errors stay visible and announce assertively", () => {
    mount();
    act(() => void pushActionToast({ kind: "error", message: "失败" }));
    const element = toast("error");
    expect(element.getAttribute("role")).toBe("alert");
    advance(60_000);
    expect(document.querySelector(".sh-toast-error")).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test packages/client-core/test/toasts.test.tsx`
Expected: FAIL — `Toasts` still requires a `client` prop and reads `notices`.

- [ ] **Step 3: Rewrite `Toasts` as a store subscriber**

In `packages/client-core/src/components/shell/Toasts.tsx`:

- Drop `SessionClient` and `Notice` imports.
- Read the list with `useSyncExternalStore(subscribeActionToasts, getToasts)`.
- Keep one `useEffect` that schedules `dismissActionToast(id)` for every finite `expiresAt` and clears the timers on change.
- Keep the per-item hover/focus pause logic, calling `pauseActionToast` / `resumeActionToast` instead of local `expiresAt` state.
- Keep `.sh-toasts`, `.sh-toast`, `.sh-toast-${kind}`, `role`, `aria-live`, and the close button.
- Export `function Toasts(): ReactNode`.

- [ ] **Step 4: Make `#pushNotice` delegate to the store**

In `packages/client-core/src/lib/client.ts`:

- Import `pushActionToast` from `./action-toast`.
- Replace `#pushNotice` body with `pushActionToast({ kind: level, message })`.
- Delete `#notices`, `#noticeSeq`, `MAX_NOTICES`, the `notices` snapshot field, and the `Notice` interface if nothing else imports it.

In `packages/client-core/src/lib/host-client.ts`, do the same: delete its `#notices`, `Notice` import, and `notices` snapshot field; `#pushNotice` delegates to `pushActionToast`.

- [ ] **Step 5: Update the mount and the remaining test**

- `packages/client-core/src/app.tsx:839`: `<Toasts />`.
- `packages/client-core/src/lib/host-client.test.ts`: replace the recap assertion with a store assertion. Import `dismissActionToast, getToasts` from `../lib/action-toast`, drain them in the file's `afterEach`, and add this local helper next to `onceSnapshot`:

```ts
async function waitForStoreToast(message: string): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if (getToasts().some(toast => toast.message.includes(message))) return;
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  throw new Error(`toast not published: ${message}`);
}
```

Then the recap case becomes:

```ts
await waitForStoreToast("You've been idle — recap");
expect(getToasts().at(-1)).toMatchObject({ kind: "info" });
```

- [ ] **Step 6: Run the client-core tests**

Run: `bun test packages/client-core/test/toasts.test.tsx packages/client-core/src/lib/host-client.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/client-core/src/lib/client.ts packages/client-core/src/lib/host-client.ts packages/client-core/src/components/shell/Toasts.tsx packages/client-core/src/app.tsx packages/client-core/test/toasts.test.tsx packages/client-core/src/lib/host-client.test.ts
git commit -m "feat: route session notices through the shared toast store"
```

---

### Task 3: Map desktop session events into the stack

**Files:**
- Create: `packages/desktop-app/src/lib/session-notice.ts`
- Create: `packages/desktop-app/test/session-notice.test.ts`
- Modify: `packages/desktop-app/src/lib/session-store.ts` (agent-event switch before `default`)
- Modify: `packages/desktop-app/test/session-store.test.ts`

**Interfaces:**
- Consumes: `ActionToastInput` from Task 1; `t` from `@musepi/client-core`.
- Produces:

```ts
type SessionNoticeEvent =
  | { type: "notice"; level: "info" | "warning" | "error"; message: string; source?: string }
  | { type: "auto_retry_start"; attempt: number; maxAttempts: number; errorMessage: string }
  | { type: "auto_retry_end"; success: boolean; finalError?: string }
  | { type: "auto_compaction_start"; reason: string }
  | { type: "auto_compaction_end"; aborted: boolean; errorMessage?: string; skipped?: boolean };

type SessionNoticeAction = { toast: ActionToastInput } | { dismiss: string };
export function sessionNoticeForEvent(event: SessionNoticeEvent): SessionNoticeAction | null;
```

- [ ] **Step 1: Write the failing mapping test**

Create `packages/desktop-app/test/session-notice.test.ts` with cases:

```ts
expect(sessionNoticeForEvent({ type: "notice", level: "warning", message: "daemon says", source: "update" }))
  .toEqual({ toast: { kind: "warning", message: "daemon says", dedupeKey: "session:notice:update" } });
expect(sessionNoticeForEvent({ type: "notice", level: "info", message: "x" }))
  .toEqual({ toast: { kind: "info", message: "x", dedupeKey: "session:notice:daemon" } });
expect(sessionNoticeForEvent({ type: "auto_retry_start", attempt: 2, maxAttempts: 3, errorMessage: "429" }))
  .toEqual({ toast: { kind: "info", message: t("sessions.retryWithAttemptWithMaxWithReason", { attempt: "2", max: "3", reason: "429" }), dedupeKey: "session:retry" } });
expect(sessionNoticeForEvent({ type: "auto_retry_end", success: true }))
  .toEqual({ dismiss: "session:retry" });
expect(sessionNoticeForEvent({ type: "auto_retry_end", success: false, finalError: "boom" }))
  .toEqual({ toast: { kind: "error", message: "boom", dedupeKey: "session:retry" } });
expect(sessionNoticeForEvent({ type: "auto_compaction_start", reason: "threshold" }))
  .toEqual({ toast: { kind: "info", message: t("sessions.compactingContextWithReason", { reason: "threshold" }), dedupeKey: "session:compaction" } });
expect(sessionNoticeForEvent({ type: "auto_compaction_end", aborted: false, skipped: true }))
  .toEqual({ dismiss: "session:compaction" });
expect(sessionNoticeForEvent({ type: "auto_compaction_end", aborted: true }))
  .toEqual({ toast: { kind: "info", message: t("sessions.compactionAborted"), dedupeKey: "session:compaction" } });
expect(sessionNoticeForEvent({ type: "auto_compaction_end", aborted: false, errorMessage: "nope" }))
  .toEqual({ toast: { kind: "error", message: t("sessions.compactionFailedWithReason", { reason: "nope" }), dedupeKey: "session:compaction" } });
expect(sessionNoticeForEvent({ type: "auto_compaction_end", aborted: false }))
  .toEqual({ toast: { kind: "info", message: t("sessions.contextCompacted"), dedupeKey: "session:compaction" } });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test packages/desktop-app/test/session-notice.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement the pure helper**

Create `packages/desktop-app/src/lib/session-notice.ts` with the union and switch above. Import `t` from `@musepi/client-core` and `type ActionToastInput` from `./action-toast`.

- [ ] **Step 4: Run the helper test**

Run: `bun test packages/desktop-app/test/session-notice.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing store-wiring test**

Add to `packages/desktop-app/test/session-store.test.ts`:

```ts
it("routes a notice event into the toast stack", async () => {
  const store = new GuiSessionStore("s1", { entries: [], cursor: 0 }, "/tmp");
  store.apply({ kind: "event", seq: 1, payload: { type: "notice", level: "warning", message: "daemon says" } });
  await settle();
  expect(getToasts().at(-1)).toMatchObject({ kind: "warning", message: "daemon says" });
});
```

Import `dismissActionToast, getToasts` from `@musepi/client-core`; drain in `afterEach` of that file.

- [ ] **Step 6: Run it to verify it fails**

Run: `bun test packages/desktop-app/test/session-store.test.ts`
Expected: FAIL — no toast appears.

- [ ] **Step 7: Wire the switch**

In `packages/desktop-app/src/lib/session-store.ts`, import `dismissActionToastSource, pushActionToast` from `./action-toast` and `sessionNoticeForEvent` from `./session-notice`. Before `default`, add:

```ts
case "notice":
case "auto_retry_start":
case "auto_retry_end":
case "auto_compaction_start":
case "auto_compaction_end": {
  const action = sessionNoticeForEvent(ev);
  if (!action) break;
  if ("dismiss" in action) dismissActionToastSource(action.dismiss);
  else pushActionToast(action.toast);
  break;
}
```

- [ ] **Step 8: Run the desktop tests**

Run: `bun test packages/desktop-app/test/session-notice.test.ts packages/desktop-app/test/session-store.test.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add packages/desktop-app/src/lib/session-notice.ts packages/desktop-app/test/session-notice.test.ts packages/desktop-app/src/lib/session-store.ts packages/desktop-app/test/session-store.test.ts
git commit -m "feat: surface retry and compaction notices in the desktop toast stack"
```

---

### Task 4: Desktop stack interaction — collapse, exit, ring, cancel

**Files:**
- Modify: `packages/desktop-app/src/components/ActionToast.tsx`
- Modify: `packages/desktop-app/src/styles/gui-widgets.css:4445-4568`
- Modify: `packages/desktop-app/test/action-toast.test.ts`

**Interfaces:**
- Consumes: all Task 1 store exports, including `cancelLabel` / `onCancel` and `ttlFor`.
- Produces: `.gui-action-toasts[data-expanded]`, `.gui-action-toast--closing`, `.gui-toast-ring`, `[data-paused]`, and `.gui-action-toast-cancel`.

- [ ] **Step 1: Write the failing view tests**

Add to `packages/desktop-app/test/action-toast.test.ts`:

```tsx
test("a collapsed stack expands on hover and focus", () => {
  mountStack();
  act(() => {
    pushActionToast({ message: "one", dedupeKey: "1" });
    pushActionToast({ message: "two", dedupeKey: "2" });
  });
  const stack = document.querySelector(".gui-action-toasts") as HTMLElement;
  expect(stack.dataset.expanded).toBe("false");
  act(() => stack.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
  expect(stack.dataset.expanded).toBe("true");
  act(() => stack.dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: document.body })));
  expect(stack.dataset.expanded).toBe("false");
  act(() => (document.querySelector(".gui-action-toast-close") as HTMLButtonElement).focus());
  expect(stack.dataset.expanded).toBe("true");
});

test("closing plays the exit class before unmounting", () => {
  vi.useFakeTimers();
  mountStack();
  act(() => void pushActionToast({ message: "bye" }));
  act(() => (document.querySelector(".gui-action-toast-close") as HTMLButtonElement).click());
  expect(document.querySelector(".gui-action-toast--closing")).not.toBeNull();
  act(() => vi.advanceTimersByTime(180));
  expect(document.querySelector(".gui-action-toast--closing")).toBeNull();
});

test("cancel runs before the toast is dismissed", () => {
  let cancelled = 0;
  mountStack();
  act(() =>
    void pushActionToast({ message: "retry?", cancelLabel: "取消", onCancel: () => cancelled++ }),
  );
  act(() => (document.querySelector(".gui-action-toast-cancel") as HTMLButtonElement).click());
  expect(cancelled).toBe(1);
  expect(document.querySelector(".gui-action-toast")).toBeNull();
});

test("errors carry no countdown ring and pause freezes it", () => {
  mountStack();
  act(() => void pushActionToast({ message: "info" }));
  expect(document.querySelector(".gui-toast-ring")).not.toBeNull();
  act(() => void pushActionToast({ kind: "error", message: "bad" }));
  const error = document.querySelector(".gui-action-toast--error") as HTMLElement;
  expect(error.querySelector(".gui-toast-ring")).toBeNull();
  hover(document.querySelector(".gui-action-toast") as HTMLElement, true);
  expect((document.querySelector(".gui-action-toast") as HTMLElement).dataset.paused).toBe("true");
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test packages/desktop-app/test/action-toast.test.ts`
Expected: FAIL — no `data-expanded`, no closing class, no cancel button, no ring.

- [ ] **Step 3: Implement the view**

In `ActionToast.tsx`:

- `ActionToastStack`: local `expanded` state; `data-expanded={expanded || active.length <= 1}` on `.gui-action-toasts`; `onMouseEnter`/`onMouseLeave` and `onFocusCapture`/`onBlurCapture` set it (mouse events, not pointer events, so the existing happy-dom hover helper drives them).
- Keep the timer effect, but call a local `dismiss(toast)` that adds the toast to a `leaving` array, calls `dismissActionToast(toast.id)`, and clears it after `180` ms via a tracked timer. Render the active `toasts` plus `leaving`, the latter with `gui-action-toast--closing`. Mark the newest active toast `gui-action-toast--front` so collapsed peers never include an exiting item.
- `ActionToastItem`: add `data-paused` from the local paused state; render the ring inside the close button for non-errors with inline `animationDuration: ttlFor(kind)`; render `cancelLabel` as `.gui-action-toast-cancel` before the primary button, calling `onCancel` then dismissing.
- Focus reachability: collapsed peers keep their close/action buttons in the tab order; `onFocusCapture` expands the stack before the next Tab lands.

- [ ] **Step 4: Add the CSS**

In `gui-widgets.css`:

- `.gui-action-toasts[data-expanded="false"] .gui-action-toast:not(.gui-action-toast--front):not(.gui-action-toast--closing)` → `max-height: 10px; overflow: hidden; opacity: .55; pointer-events: none; padding-top: 0; padding-bottom: 0;` with a `max-height 180ms` / `opacity 180ms` transition. Expanded items use `max-height: 400px; opacity: 1; pointer-events: auto;`.
- `.gui-action-toast--closing` → 180 ms `gui-action-toast-out` keyframe (`opacity: 0; transform: translateY(6px)`).
- `.gui-toast-ring` → 16 px circle, `stroke-dasharray: 100`, `stroke-dashoffset: 100`, `animation: gui-toast-ring linear forwards`, `animation-duration` set inline; `@keyframes gui-toast-ring { to { stroke-dashoffset: 0; } }`.
- `.gui-action-toast[data-paused="true"] .gui-toast-ring { animation-play-state: paused; }`.
- `.gui-action-toast-cancel` → secondary text button, 12 px, muted; hover foreground.
- Add both new animations to the `.gui-motion-off` / `prefers-reduced-motion` reset blocks.

- [ ] **Step 5: Run the view tests**

Run: `bun test packages/desktop-app/test/action-toast.test.ts`
Expected: PASS.

- [ ] **Step 6: Run the package checks**

Run: `bun --cwd=packages/desktop-app run check`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/desktop-app/src/components/ActionToast.tsx packages/desktop-app/src/styles/gui-widgets.css packages/desktop-app/test/action-toast.test.ts
git commit -m "feat: add stacked expand, exit, countdown, and cancel to desktop toasts"
```

---

### Task 5: Document the notification contract and update the changelog

**Files:**
- Create: `docs/gui-notification-spec.md`
- Create: `docs/gui-notification-spec.zh-CN.md`
- Modify: `docs/gui-design.md` §5x, `docs/gui-design.zh-CN.md`
- Modify: `docs/gui-implementation.md` §45.3, `docs/gui-implementation.zh-CN.md`
- Modify: `docs/extensions-dev.md` §19, `docs/extensions-dev.zh-CN.md`
- Modify: `packages/coding-agent/CHANGELOG.musepi.md` `[Unreleased]`

**Interfaces:**
- Consumes: the final API and behavior from Tasks 1–4; this task only writes prose.

- [ ] **Step 1: Write the spec pair**

Cover, in both locales, with the same structure:

- API shape and kind semantics (icon + tint; glass surface stays neutral).
- TTL table, capacity, dedupe, source recovery, pause/resume.
- Placement: desktop `.gui-toast-corner` z 910, guest `.sh-toasts` strip; `UpdateToast` shares the corner but is a separate OTA surface.
- Stack interaction: collapsed slivers, hover/focus expansion, exit, ring, cancel; reduced motion.
- Accessibility contract.
- Entry points: `pushActionToast`, `musepi-gui-toast`, `window.MusePiHostModules["action-toast"]`.
- Boundary: OS notifications live in `notify.ts` and Settings → 通知与音效.

- [ ] **Step 2: Update the owning docs**

- `gui-design.md` §5x and its Chinese pair: add the stack/ring/cancel rules and the shared-store ownership.
- `gui-implementation.md` §45.3 and its Chinese pair: state that the store lives in `client-core`, that the desktop module re-exports it, and that session events map through `session-notice.ts`.
- `extensions-dev.md` / `.zh-CN.md` §19: the `action-toast` table row now points at the client-core store re-exported by `lib/action-toast.ts`, and still guarantees one instance.

- [ ] **Step 3: Add the changelog entry**

Under `[Unreleased]`, one bullet with Chinese copy and an inline `EN:` line: the in-app notification stack is now one shared contract, desktop session notices appear there, and the stack expands on hover with a countdown ring and cancel action.

- [ ] **Step 4: Run documentation gates**

Run: `bun check:docs && bun check:changelog-i18n && bun run verify-translation-pairing`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add docs/gui-notification-spec.md docs/gui-notification-spec.zh-CN.md docs/gui-design.md docs/gui-design.zh-CN.md docs/gui-implementation.md docs/gui-implementation.zh-CN.md docs/extensions-dev.md docs/extensions-dev.zh-CN.md packages/coding-agent/CHANGELOG.musepi.md
git commit -m "docs: publish the in-app notification spec"
```

---

### Task 6: Whole-change verification

**Files:** none.

- [ ] **Step 1: Run the focused test battery**

Run:

```bash
bun test packages/client-core/test/action-toast.test.ts packages/client-core/test/toasts.test.tsx packages/client-core/src/lib/host-client.test.ts packages/desktop-app/test/action-toast.test.ts packages/desktop-app/test/session-notice.test.ts packages/desktop-app/test/session-store.test.ts packages/desktop-app/test/host-modules.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run package checks**

Run: `bun --cwd=packages/client-core run check` and `bun --cwd=packages/desktop-app run check`.
Expected: PASS.

- [ ] **Step 3: Run repository gates touched by the change**

Run: `bun check:docs && bun check:css-structure && bun check:glass-backdrop && bun check:dead-code`.
Expected: PASS.

- [ ] **Step 4: Desktop manual pass**

Build the renderer (`bun --cwd=packages/desktop-app run build`) and launch it. Verify: a failed retry appears as a persistent error in the corner; hovering a three-toast stack expands it; the close ring freezes on hover; closing plays the 180 ms exit; a cancel action resolves before dismissal; the guest web shell still shows the bottom strip.
