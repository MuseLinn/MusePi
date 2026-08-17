# TUI core renderer — the append-only contract

What you are dealing with before you touch the rendering engine. This is the
companion to [`tui-runtime-internals.md`](./tui-runtime-internals.html): that doc
maps the *flow* (input → component tree → render); this doc explains the
**render contract, why it is shaped this way, and the invariants you must not
violate**. Scope is the core engine only:

- [`packages/tui/src/tui.ts`](../packages/tui/src/tui.ts) — frame pipeline, commit ledger, window math, emitters, cursor placement.
- [`packages/tui/src/terminal.ts`](../packages/tui/src/terminal.ts) — `ProcessTerminal`, capability probes, private-CSI reassembly.
- [`packages/tui/src/terminal-capabilities.ts`](../packages/tui/src/terminal-capabilities.ts) — `TERMINAL` profile, sync-output / DECCARA / image detection.
- [`packages/tui/src/stdin-buffer.ts`](../packages/tui/src/stdin-buffer.ts) — escape-sequence reassembly.
- [`packages/tui/src/utils.ts`](../packages/tui/src/utils.ts) — width/slice/wrap (the width model).
- [`packages/tui/src/kitty-graphics.ts`](../packages/tui/src/kitty-graphics.ts) + [`components/image.ts`](../packages/tui/src/components/image.ts) — inline images.
- [`packages/tui/src/deccara.ts`](../packages/tui/src/deccara.ts) — rectangular-fill optimizer.

Application-layer renderers (transcript, tool calls, session tree, editor,
widgets) are **out of scope** — they live in `packages/coding-agent`. The one
app-layer file that is load-bearing for this contract is
[`transcript-container.ts`](../packages/coding-agent/src/modes/components/transcript-container.ts),
which implements the commit-boundary seam described below.

---

## 1. The one thing to understand first

> **The renderer cannot observe the terminal's scroll position** (ConPTY's
> probe lies; POSIX has no API at all). The previous engine tried to *guess*
> when it was safe to rewrite native scrollback, and every policy choice over
> that unobservable variable traded one failure family for another (yank ↔
> flash ↔ corruption ↔ invisible-until-resize — see the git history of this
> file for the full war journal). The current engine removes the guess
> entirely: **native scrollback is append-only.**

We keep the transcript on the **normal screen** (native scrollback, native
selection, transcript persists after exit). The engine maintains one ledger:

- **`committedRows` (C)** — frame rows `[0, C)` have been physically scrolled
  into terminal history. They are **immutable**: the engine never rewrites
  them, and components must never change them.
- **`windowTopRow` (W)** — the frame row mapped to grid row 0. The visible
  window is frame rows `[W, W + height)`, repainted in place with relative
  cursor moves.
- **commit boundary** — reported by the component tree per frame
  (`NativeScrollbackLiveRegion`) as two nested ends:
  - **byte-stable end (B)** — `commitSafeEnd ?? liveRegionStart ?? frame.length`.
    Rows below B are asserted never to re-layout and stay under the
    committed-prefix audit.
  - **durable end (D)** — `max(B, snapshotSafeEnd ?? B)`. Rows in `[B, D)` may
    still drift bytes later (a streaming markdown table re-aligning columns) but
    are *durable* — their current snapshot is permanent content, so dropping them
    when they scroll off is forbidden. They commit **audit-exempt**: later drift
    becomes a frozen stale row in history, never a re-anchor.

Per ordinary frame: `W = max(C, L − height)`, `C' = max(C, min(D, W))`, and the
only bytes that ever touch history are the **chunk** `frame[C, C')` written at
the scrollback seam. The engine also tracks **`auditRows` (A ≤ C)** — the
byte-stable leading prefix `[0, A)`; the committed-prefix audit (§2) samples only
that prefix, so the durable suffix `[A, C)` drifting never triggers a re-anchor.
Scrollback therefore equals `frame[0..C)` — every row exactly once, in order,
with its content at commit time. There is nothing to guess, nothing to defer,
and nothing to reconcile: the scroll position is irrelevant because ordinary
updates never rewrite anything a scrolled reader could be looking at.

### What this costs (the accepted tradeoffs)

- A block that has scrolled past the window top cannot reflow in place. A
  byte-stable block stays in the live region (below B) until final; a durable
  block (below D) commits its scroll-off snapshot, so a late layout change of an
  already-committed row is a frozen stale row in history (duplication never loss),
  not a dropped row.
- A component tree that reports **no seam** gets shell semantics: whatever
  scrolls off is final. Shrinking such a frame into its committed prefix
  re-anchors the window and leaves the stale copy in history (§3).
- Inside ED3-unsafe multiplexers, a width change terminates the physical-row
  coordinate epoch. The renderer captures an opaque
  `NativeScrollbackWidthEpoch` marker from the last emitted source state before
  `SIGWINCH`, then resolves that same logical boundary after the settled-width
  render. Host-reflowed history stays immutable. Output queued during
  settlement is emitted only from the resolved old boundary to the current
  source boundary at the terminal-owned viewport bottom; the settled viewport
  then repaints in place. No old-width and new-width row counts are compared,
  and no old viewport row is recommitted. Components without the source
  contract retain the conservative physical-row fallback. Visible overlays
  freeze the seam and pinned live regions clip advancement at their final
  boundary. Height-only resizes retain the existing ledger.
- Direct HerdR panes are not in that category. HerdR's Ghostty core implements
  ED3, so OMP clears and replays its source-owned transcript after settlement,
  matching direct terminals. Repainting host-reflowed rows in place would
  harden soft wraps and leave residual rows after a later width reversal.

---

## 2. The frame pipeline (what you are editing)

`#doRender` per frame:

1. Compose the frame, collecting the first root child's
   `getNativeScrollbackLiveRegionStart()` and optional pinning policy.
2. Audit the committed exact prefix (`findCommittedPrefixResync`, skipped on
   geometry frames). The detector samples the prefix tail (up to 8 non-blank
   rows in the last 24, SGR-stripped). A single in-place mismatch is accepted
   as stale history; a structural shift re-anchors at the first changed row,
   favoring duplication over content loss. An in-place width change does not
   audit or re-slice the prior epoch's physical coordinates; it resolves the
   captured logical source marker in the settled-width frame.
3. Classify the frame as a gesture-driven full paint, an opt-in divergence
   rebuild, or an ordinary update and calculate the window/commit chunk.
   Overlays freeze commits. A pinned live region clips its offscreen mutable
   suffix instead of snapshotting it.
4. Extract cursor markers, prepare width-safe lines, slice the window, and
   composite overlays into the screen-coordinate window only.
5. Emit:

| Emitter                      | Bytes                                              | When                                                                |
| ---------------------------- | -------------------------------------------------- | ------------------------------------------------------------------- |
| `#emitFullPaint`             | home + committed chunk + window rows; optional ED3 | initial paint, explicit geometry/session/reset gestures, or rebuild |
| `#emitUpdate` scroll-append  | new bottom rows plus changed-row range             | rows leaving the screen are exactly the commit chunk                |
| `#emitUpdate` in-window diff | relative move plus changed-row rewrite             | nothing scrolls or commits                                          |
| `#emitUpdate` seam rewrite   | commit chunk plus full window rewrite              | commit/window re-anchor or hidden-gap backfill                      |

**ED3 (`CSI 3 J`) is emitted in exactly one place** —
`#emitFullPaint({ clearScrollback: true })`. The normal callers are explicit
user gestures: session replace/branch/resume
(`requestRender(true, { clearScrollback: true })`), resize outside a
multiplexer, and `resetDisplay()` (the display-reset chord, `Alt+L` by
default). It clears native history without `ED2` first; the replay overwrites
every row from home so terminals without synchronized output do not expose a
blank viewport. A gesture pins the user to the tail, so the history snap is
acceptable.

The second caller is an ordinary-render divergence when
`tui.scrollbackRebuild` is enabled: if the committed prefix structurally
resynchronizes or the current frame collapses into committed rows, the renderer
clears and replays the current frame to replace stale preview history with the
final form. This path is disabled by default and never runs after the first
paint, during an explicit replacement/geometry frame, or inside a multiplexer.
Multiplexers never get ED3 (it is a no-op there and a replay would duplicate
pane history).
The ordinary update path never emits ED2/ED3 or an absolute cursor home —
several terminal families snap a scrolled reader to the bottom on those.

### The commit-boundary seam (the load-bearing app contract)

`NativeScrollbackLiveRegion` has one boundary and one optional policy:

- `getNativeScrollbackLiveRegionStart()` returns the first local row that may
  still mutate. Rows before it are declared byte-stable at the current width.
- `isNativeScrollbackLiveRegionPinned()` keeps the mutable suffix
  viewport-local rather than recording frozen snapshots as it scrolls off.
  This is for replacing dashboards, not append-shaped transcript content.
- Reporting no seam gives shell semantics: rows commit as they scroll.

When multiple root children report a seam, the topmost seam wins because
commits are prefix-only. `NativeScrollbackCommittedRows` lets containers pass
the committed count down to children, and `NativeScrollbackReplay` lets
components release layout locks before a destructive replay.

`NativeScrollbackWidthEpoch` is the cross-width source contract. Capture reads
only state that produced the last emitted frame. Resolve projects that source
boundary into the newly rendered width, while the current-boundary method
identifies the logical suffix queued during settlement. Containers propagate
the marker through nested sources; Markdown snapshots its last rendered source
text, so a streaming update received before `SIGWINCH` cannot masquerade as
already-emitted output.

`TranscriptContainer` implements the application seam. It scans for the first
unfinalized transcript block. Finalized blocks before it are exact; that live
block may extend the exact boundary through
`getTranscriptBlockSettledRows()`. Assistant messages derive those settled
rows from completed content blocks and markdown's frozen-token prefix, while
constructs that can re-layout asynchronously (for example Mermaid) defer
settling. Pinning is propagated from the first live block; tool execution uses
it for replacing preview/dashboard states.

Transcript assembly also reports `RenderStablePrefix`: unchanged component
array references at unchanged offsets let the engine skip work over the
byte-identical prefix. Components that discard or lock committed material must
honor the committed-row and replay hooks. Freezing/settling is a correctness
contract, not a terminal-specific optimization.
---

## 3. Invariants — MUST / NEVER

1. **NEVER add a new `CSI 3 J` (ED3) callsite.** ED3 flows only through
   `#emitFullPaint({ clearScrollback: true })`, only for gestures, never inside
   multiplexers.
2. **NEVER rewrite a committed row.** No emitter may touch frame rows `< C`,
   and `W ≥ C` always (re-showing a committed row on the grid duplicates it
   for a scrolling reader — the historical corruption family). When a
   *component* violates immutability, the audit (§2) degrades to duplication —
   never silently skip rows, never erase history.
3. **Commits are exactly the chunk.** Any byte shape that scrolls the screen
   must scroll only rows accounted for by the commit advance.
4. **An ED3-unsafe multiplexer width resize NEVER advances history.** The old
   committed physical-row coordinate is opaque after reflow. The resize leaves
   the host-reflowed viewport in place and establishes a complete-frame
   baseline independent of the native commit count. Subsequent growth writes
   the exact current-width rows newly crossing the seam—not blank scroll
   commands—then repaints the bounded viewport; only that slice advances
   commits. Visible overlays advance neither the baseline nor the seam ledger;
   overlay exit backfills the exact hidden slice. Pinned live regions advance
   only through their final boundary; finalization releases the deferred
   mutable slice. During a height shrink, only occupied old-frame rows actually
   moved into history by the host are excluded from the append-owned seam;
   empty viewport rows do not consume content-driven movement. Height-only
   resizes do not terminate the epoch. Direct HerdR uses ED3 source replay
   instead.
5. **NEVER probe the viewport position or fork on platform in the update   path.** win32 behaves like POSIX. The probe APIs are gone; do not
   reintroduce them.
6. **Only declare rows exact when their bytes are stable.** Mutable transcript
   content may commit as an unpinned frozen snapshot, but rows before the seam
   remain under the exact-prefix audit.
7. **Park the hardware cursor at real content bottom**, not the padded window   bottom, or height shrinks scroll live rows into history and duplicate them
   per resize step.
8. **Cursor writes live inside the synchronized-output frame**, before ESU —
   never as a second frame after it.
9. **NEVER throw in the render hot path.** Clamp over-wide lines
   (`truncateToWidth`); a width mismatch is cosmetic, not fatal.
10. **Multiplexers get no destructive clear and no history rewrap on resize** —
    repaint the window in place; pane history keeps its old wrap.
11. **Any change to the ledger math, the emitters, or the seam must be
    validated by the stress harness (§6)** across its full scenario matrix,
    not by a single-terminal smoke test.

---

## 4. Terminal capability detection

`TERMINAL` (`terminal-capabilities.ts`) is resolved once at import from
`TERMINAL_ID` plus environment sniffing; detection helpers are pure over
`(env, platform)` and unit-testable.

- `shouldEnableSynchronizedOutputByDefault(env, id)` → DEC 2026 default.
  Precedence: user opt-out (`PI_NO_SYNC_OUTPUT`/`PI_TUI_SYNC_OUTPUT=0`) → user
  force-on (`PI_FORCE_SYNC_OUTPUT=1`/`PI_TUI_SYNC_OUTPUT=1`) → `TERM_FEATURES`
  advertises `Sy` → `WT_SESSION` → known direct terminals → off for risky
  multiplexers and unknowns. Reconciled at runtime by the DECRQM mode-2026
  report; a user override still wins.
- `detectRectangularSgrSupport(id, env)` → DECCARA fills: kitty only, off in
  multiplexers and under `PI_NO_DECCARA`.
- `supportsScreenToScrollback` → kitty's ED22 (used once, on the initial
  paint, to preserve the pre-existing shell screen).

The old ED3-risk classifier (`eagerEraseScrollbackRisk`, `PI_TUI_ED3_SAFE`,
`submitPinsViewportToTail`) is gone: behavior no longer depends on which
terminal is rendering, so there is no risk class to detect. Env sniffing now
only selects *optimizations* (sync output, DECCARA, images), where a miss is
cosmetic, not corrupting.

---

## 5. Width model

`visibleWidth` / `truncateToWidth` / `sliceByColumn` / `wrapTextWithAnsi`
(`utils.ts`) all agree on **one UAX#11 width model**. Slicing, truncation,
wrapping, and segment extraction run on the native engine
(`@musepi/pi-natives`, Rust `unicode-width`); `visibleWidth` measures with
`Bun.stringWidth` **pinned to that same model** (`STRING_WIDTH_OPTS`:
`countAnsiEscapeCodes: false`, `ambiguousIsNarrow: true`) — a JSC builtin that
shares the native width tables without the per-call N-API box the native
scanner traps on under Bun 1.3.x. The two must never disagree; mixing unpinned
width models in measure-vs-slice produced crashes.

- Fast path: printable ASCII is one cell per code unit.
- Anything past the ASCII prefix measures through `Bun.stringWidth` (CSI/OSC
  stripped to zero); tabs are added back at the fixed `DEFAULT_TAB_WIDTH` columns.
- OSC 66 sized spans are added back as `scale × (explicit w ?? payload width)` —
  `Bun.stringWidth` would otherwise strip the whole span to zero.

**Rule:** any new measuring code routes through these helpers, and the hot
path clamps instead of throwing. Known residual: combining-heavy scripts
(Arabic harakat) survive painting verbatim, but ghostty-web's cell readback can
migrate non-spacing marks across cells — the stress harness compares those rows
with marks stripped (`sameLinesAllowingMarkDrift`).

---

## 6. The fidelity gate (use it)

`packages/tui/test/render-stress-harness.ts` drives the renderer's **real
emitted ANSI** into a ghostty-web `VirtualTerminal` across randomized op
sequences and parameterized terminal shapes, and validates the contract with a
**shadow commit ledger**: an independent reimplementation of §1's math, fed
only by observed frames (a `render` wrap) and observed bytes (a `write` wrap).
Per op it asserts:

- the whole tape (scrollback + grid) equals `shadowTape + window slice`, row
  for row, including across resizes;
- scrolled readers stay pinned and visible history rows are never rewritten;
- multiplexer pane history grows by exactly the committed chunk;
- sync-output/autowrap bracket discipline, cursor parking, background columns,
  duplicate accounting.

Run it — plus `render-regressions.test.ts`,
`streaming-scrollback-defer.test.ts`, and the `issue-*-repro.test.ts` files —
before changing ledger math, emitters, or the seam. A change that passes one
terminal and one seed is not verified.

---

## 7. Capability probes & stdin reassembly

`ProcessTerminal` fuses capability queries with a bare DA1 (`CSI c`) sentinel so
a non-answering terminal is detected when DA1 returns first. Replies can arrive
**split across a stdin flush**, so:

- `#privateCsiResponseBuffer` accumulates `\x1b[?…` partials while a sentinel is
  outstanding, rejoins on the terminator byte, then runs the handlers on the
  **complete** reply. A new `\x1b` mid-reassembly or >256 bytes abandons the
  partial so real keys still reach input.
- `#da1SentinelOwners` is a **typed FIFO** discriminated by `kind` so a
  keyboard DA1 cannot be mistaken for an OSC 11 / DECRQM / graphics-probe
  sentinel.
- DECRQM probes (2026/2048/2031) drive runtime feature gating.

**Rule:** any new probe must own a typed sentinel and survive a split reply
(feed the reply byte-by-byte in a test and assert nothing leaks to input).

---

## 8. Inline images & memory

Kitty images are **transmit-once, place-many** (`kitty-graphics.ts`).
`ImageBudget` keeps only the most-recent N images live; when the cap is
exceeded the demoted image's pixels are deleted by id (`a=d,d=I`) and its
visible rows re-render as the text fallback through the ordinary window diff —
**no destructive replay**. A demoted placement already committed to history
simply loses its pixels (committed rows are immutable), and the text fallback
is **height-preserving** once a graphic has rendered (reserved rows + fallback
line), so demotion never shrinks the block and never shifts committed content
below it.

**Rule:** never re-emit full base64 per frame. Kitty Unicode placeholders are
default-on only for kitty/ghostty (`PI_NO_KITTY_PLACEHOLDERS` /
`PI_KITTY_PLACEHOLDERS`).

---

## 9. Escape hatches (env vars)

| Var | Effect |
|---|---|
| `PI_NO_SYNC_OUTPUT=1` | Disable DEC 2026 BSU/ESU wrappers (autowrap discipline stays on). |
| `PI_TUI_SYNC_OUTPUT=0\|1` / `PI_FORCE_SYNC_OUTPUT=1` | Force sync output off / on. |
| `PI_NO_DECCARA` | Disable Kitty DECCARA rectangular-fill optimization. |
| `PI_FORCE_IMAGE_PROTOCOL=kitty\|iterm2\|sixel\|off` | Override image protocol detection. |
| `PI_NO_KITTY_PLACEHOLDERS=1` / `PI_KITTY_PLACEHOLDERS=1` | Force Kitty Unicode placeholders off / on. |
| `PI_HARDWARE_CURSOR=1` | Show the real hardware cursor instead of a rendered one. |
| `PI_NOTIFICATIONS=off\|0\|false` | Suppress terminal notifications. |
| `PI_DEBUG_REDRAW=1` | Log the chosen render intent + ledger state per frame to the debug log. |
| `PI_TUI_RESIZE_IN_PLACE=1\|0` | Force resize to repaint in place (no alt-screen borrow, no ED3 rewrap) on / off. Default-on for terminals that re-report size on alt-screen toggles (Warp). |

Removed with the old engine: `PI_TUI_ED3_SAFE` (no ED3-risk lever exists),
`PI_CLEAR_ON_SHRINK` (shrinks always clear exactly), `PI_TUI_DEBUG` (per-render
dump superseded by `PI_DEBUG_REDRAW` ledger logging and the stress harness
replay/reduce tooling).

---

## 10. Before you touch the render core — checklist

- [ ] Are you about to emit `CSI 3 J` anywhere other than the gesture-driven
      `clearScrollback` full paint? **Stop.**
- [ ] Could any code path rewrite, or re-show on the grid, a frame row below
      `committedRows`? **Stop.**
- [ ] Does your byte shape scroll rows that are not the commit chunk? That
      breaks `scrollback == frame[0..C)`.
- [ ] Are you adding a viewport probe, a platform fork, or a terminal-brand
      branch to the update path? The contract exists so none are needed.
- [ ] New mutable UI above the editor? It must report (or live inside) the
      live-region seam, or it will freeze at first commit.
- [ ] Did you run the stress harness and the repro suite across the full
      scenario matrix — not just one terminal and one seed?
- [ ] New probe? Typed sentinel owner + split-reply test.
- [ ] New width path? Routed through the shared native engine, clamped (never
      thrown) in the hot path.
