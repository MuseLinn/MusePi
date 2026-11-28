# Unified Voice Input Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make MusePi's global shortcut drive one streaming dictation session with internal composer and external HUD presentations, then add Windows hold-to-talk release handling.

**Architecture:** The Electron main process owns external capture/RPC/injection and routes the accelerator to a focused composer when registered. Both surfaces use `voice.frontendStream*`; only the external surface injects final text. A scoped native keyboard monitor supplies hold press/release transitions without swallowing input.

**Tech Stack:** Electron main/preload, React/TypeScript, Bun tests, Rust/napi-rs, Windows low-level keyboard hooks.

**Spec:** `docs/superpowers/specs/2026-11-27-unified-voice-input-design.md`

## Global Constraints

- Reuse `voice.frontendStream*`; do not create another ASR implementation.
- Never inject volatile previews into external applications.
- Observe only the configured hold chord, ignore injected events, pass every key through, and never log transcripts or unrelated keys.
- Windows hold support does not claim macOS parity.
- Preserve unrelated worktree changes and create scoped local commits only; never push.
- Use package scripts and `bun check` conventions; do not invoke `tsc`.

## Review Focus

- Multiple windows/composers: only the DOM-focused editor in Electron's focused window accepts the shortcut.
- Stop while audio RPCs are queued: all earlier audio arrives before `voice.frontendStreamStop`.
- Cancel/error followed by late events: stale generations never update the HUD or inject text.
- Hold auto-repeat and modifier-first release: one start and exactly one finish, including when a modifier is released before the main key.
- Hook installation failure and dispose: toggle remains available in hold-error reporting, no thread or callback survives close.

---

### Task 1: External streaming session

**Files:**
- Modify: `apps/desktop/electron/global-dictation.cjs`
- Test: `apps/desktop/test/global-dictation.test.ts`
- Create: `apps/desktop/test/global-dictation-stream.test.ts`

**Interfaces:**
- Consumes: existing `request(method, params, timeoutMs)`, `subscribe(cb)`, `AudioCapture`, and `typeIntoFocusedApp(text)`.
- Produces: `sessionId`, `streamQueue`, `streamSegments`, `streamPartial`, and `displayTranscript()` on `GlobalDictation`; `handleEvent` accepts `voice.frontendPartial` and `voice.frontendSegment` events.

- [ ] **Step 1: Write failing streamed aggregation and final-only injection tests**

Use fake RPC/native dependencies. Emit accepted segment `"第一句。"`, partial `"第二"`, then stop with final `"第一句。第二句。"`; assert recording-state HUD text is `"第一句。第二"`, stop waits for a deliberately delayed audio RPC, and `typeText` receives only the final string once. Add a stale-event-after-cancel case asserting no HUD update or injection.

- [ ] **Step 2: Run the new tests and verify RED**

Run: `bun run test:desktop test/global-dictation-stream.test.ts` from repository root.
Expected: failures because start/stop still use `stt.transcribe` and `partialText` is never populated.

- [ ] **Step 3: Replace one-shot buffering with the streaming RPC lifecycle**

Start with model/language/speaker/enhancement settings and `voice.frontendStreamStart`; serialize `voice.frontendStreamAudio`; index finalized segments and coalesce partials by session id; stop with `voice.frontendStreamStop`; align `MAX_SECONDS` with the 600-second streaming guard. Preserve download, minimum-audio, cancellation, error, clipboard recovery, and final-only `DesktopSession.typeText` behavior.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `bun run test:desktop test/global-dictation.test.ts test/global-dictation-stream.test.ts`.
Expected: all pass, including delayed-audio stop and late-event invalidation.

- [ ] **Step 5: Commit Task 1**

`git add` only Task 1 files and commit `feat(voice): stream global dictation previews`.

### Task 2: Internal shortcut routing

**Files:**
- Modify: `apps/desktop/electron/global-dictation.cjs`
- Modify: `apps/desktop/electron/preload.cjs`
- Create: `apps/desktop/src/lib/global-dictation-target.ts`
- Modify: `apps/desktop/src/components/composer/use-dictation.ts`
- Modify: `apps/desktop/src/env.d.ts`
- Test: `apps/desktop/test/global-dictation-stream.test.ts`
- Create: `apps/desktop/test/global-dictation-target.test.ts`

**Interfaces:**
- Produces preload API: `dictationTarget.setState(state: { focused: boolean; active: boolean }): Promise<void>`, `dictationTarget.onToggle(cb: () => void): () => void`.
- Produces renderer registry: `registerGlobalDictationTarget(editorDom: HTMLElement, toggle: () => void, isActive: () => boolean): () => void`.
- Consumes: `ComposerEditorHandle.dom`, actual `document.activeElement`, and `BrowserWindow.getFocusedWindow()`.

- [ ] **Step 1: Write failing main and renderer routing tests**

Main case: a DOM-focused target in the focused MusePi window receives `dictation:toggle` and neither capture nor HUD starts; an unavailable/stale target falls back externally. An active internal session retains ownership after DOM/window focus moves elsewhere so the next shortcut stops it rather than starting a second session. Renderer case: two registered editors invoke only the DOM-focused toggle, with unmount/focus-out cleanup.

- [ ] **Step 2: Run routing tests and verify RED**

Run: `bun run test:desktop test/global-dictation-target.test.ts test/global-dictation-stream.test.ts`.
Expected: missing bridge/registry and no internal route.

- [ ] **Step 3: Implement narrow preload IPC and focus registration**

Track `{ focused, active }` by `webContents.id`; route an active internal session to its owner even after focus moves, and otherwise route internally only when the focused window owns the DOM-focused target. The renderer registry subscribes once, resolves actual DOM focus, reports phase activity through `isActive`, and sends state changes. `useDictation` registers its editor DOM, latest toggle callback, and phase activity, cleaning up on unmount without implicitly cancelling active speech.

- [ ] **Step 4: Run routing and composer tests**

Run: `bun run test:desktop test/global-dictation-target.test.ts test/global-dictation-stream.test.ts` and `bun run test src/components/composer/` from `packages/client-core`.
Expected: all pass.

- [ ] **Step 5: Commit Task 2**

Commit only Task 2 files as `feat(voice): route global shortcuts to focused composers`.

### Task 3: HUD and internal composed presentation

**Files:**
- Modify: `apps/desktop/src/dictation-main.tsx`
- Modify: `apps/desktop/src/styles/dictation.css`
- Modify: `apps/desktop/src/components/composer/voice-overlays.tsx` only if the existing state styling cannot carry the internal route
- Modify: `apps/desktop/src/styles/gui-composer.css` only for a verified internal-state gap
- Create: `apps/desktop/test/dictation-hud.test.tsx`
- Modify: `apps/desktop/scripts/gui-probe-scenarios/dictation-live.tsx`

**Interfaces:**
- Consumes: Task 1 `partialText` containing cumulative finalized text plus the active preview, and existing `useDictation.phase`.
- Produces: no new data protocol; only restrained presentation.

- [ ] **Step 1: Write failing HUD rendering tests**

Render recording with cumulative `partialText`, assert it replaces the listening hint and remains visible during transcription/insertion as appropriate; verify cancel remains available and no duplicate text appears in title/detail.

- [ ] **Step 2: Run HUD test and verify RED**

Run: `bun run test:desktop test/dictation-hud.test.tsx`.
Expected: current single-line hint behavior does not satisfy cumulative transcript presentation.

- [ ] **Step 3: Implement transcript-aware HUD and any verified internal-state styling**

Keep the existing compact glass card, let transcript detail wrap and the card grow within a bounded maximum, and preserve no-focus behavior. Reuse current composer recording accents before adding any CSS; do not copy WeChat artwork or tokens.

- [ ] **Step 4: Run HUD, voice, and visual-probe checks**

Run: `bun run test:desktop test/dictation-hud.test.tsx test/voice-status-strip.test.tsx test/voice-streaming-dictation.test.ts`; run the dictation GUI probe with the package's documented command.
Expected: tests pass and probe measurements/screenshots show no overlap or focus theft.

- [ ] **Step 5: Commit Task 3**

Commit Task 3 files as `feat(voice): present live dictation in both contexts`.

### Task 4: Native hold-chord state machine

**Files:**
- Create: `crates/pi-natives/src/dictation.rs`
- Modify: `crates/pi-natives/src/lib.rs`
- Modify: `crates/pi-natives/BUILD.bazel` if the build does not glob sources
- Test: inline `crates/pi-natives/src/dictation.rs` unit tests

**Interfaces:**
- Produces: `HoldChord::parse(accelerator: &str) -> Result<HoldChord, String>` and a pure transition reducer for physical key events.
- Produces transitions: `None`, `Press`, `Release`.

- [ ] **Step 1: Write failing parser and reducer tests**

Cover `CommandOrControl+Alt+Space`, invalid/bare keys, initial press, repeated keydown, main-key release, modifier-first release, unrelated keys, and injected keydown/keyup. Expected sequences contain one `Press` followed by exactly one `Release`; unrelated/injected events contain neither.

- [ ] **Step 2: Run Rust tests and verify RED**

Run: `rtk cargo test -p pi-natives dictation::` from repository root.
Expected: module/tests missing or parser/reducer unimplemented.

- [ ] **Step 3: Implement the small platform-neutral reducer**

Parse Electron modifier names and the existing supported key vocabulary into Windows virtual-key values. Track active chord state; start only on a physical main-key press with all modifiers held, suppress auto-repeat, and release on any required key's physical release while active.

- [ ] **Step 4: Run reducer tests and verify GREEN**

Run: `rtk cargo test -p pi-natives dictation::`.
Expected: all dictation tests pass.

- [ ] **Step 5: Commit Task 4**

Commit Task 4 files as `feat(natives): model hold-to-talk chord transitions`.

### Task 5: Windows hook and N-API lifecycle

**Files:**
- Modify: `crates/pi-natives/src/dictation.rs`
- Modify: `packages/natives/native/index.d.ts` through `bun run build:bindings`
- Modify: `packages/natives/native/index.js` through the existing generator
- Create: `packages/natives/test/dictation-types.typecheck.ts`
- Modify: `packages/natives/test/desktop-types.typecheck.ts` only if the existing aggregate already imports all type fixtures

**Interfaces:**
- Produces: `new DictationKeyMonitor(accelerator: string, callback: (event: "press" | "release") => void)` and idempotent `close(): void`.
- Consumes: Task 4 parser/reducer and the existing `desktop/control/windows.rs` message-loop ownership pattern.

- [ ] **Step 1: Write failing type/lifecycle contract tests**

Assert the exposed constructor/callback/close types. Add native tests around monitor state ownership where the platform seam permits; unsupported platforms return an explicit error.

- [ ] **Step 2: Run native tests and verify RED**

Run: `rtk cargo test -p pi-natives dictation::` and `bun run test` from `packages/natives`.
Expected: `DictationKeyMonitor` is absent.

- [ ] **Step 3: Implement the scoped Windows hook and N-API owner**

Install `WH_KEYBOARD_LL` on a dedicated message-loop thread only on construction, filter with Task 4's reducer, invoke a nonblocking `ThreadsafeFunction`, and always `CallNextHookEx`. `close` posts `WM_QUIT`, joins the owner thread, releases the callback, and is safe twice. Never reuse or alter the independent emergency-Escape monitor.

- [ ] **Step 4: Regenerate bindings and run native checks**

Run: `bun run build:bindings` and `bun run check` from `packages/natives`; `rtk cargo test -p pi-natives dictation::`; repository Rust formatting/clippy through package scripts.
Expected: all affected checks pass and generated declarations contain the exact interface.

- [ ] **Step 5: Commit Task 5**

Commit Task 5 files as `feat(natives): observe hold-to-talk key release`.

### Task 6: Hold-mode Electron integration and settings

**Files:**
- Modify: `apps/desktop/electron/global-dictation.cjs`
- Modify: `apps/desktop/src/components/settings-sections/global-dictation.tsx`
- Modify: `apps/desktop/src/i18n/voice.ts`
- Modify: `packages/coding-agent/src/config/settings-schema.ts`
- Test: `apps/desktop/test/global-dictation-stream.test.ts`
- Modify: `apps/desktop/test/voice-settings.test.tsx`

**Interfaces:**
- Produces setting: `dictation.globalTrigger: "toggle" | "hold"`, default `"toggle"`.
- Consumes: Task 5 `DictationKeyMonitor`; the existing `dictation.globalShortcut` supplies the chord for both modes.

- [ ] **Step 1: Write failing trigger-mode tests**

Toggle mode uses `globalShortcut.register` and never constructs the native monitor. Hold mode constructs one monitor, first `press` starts and physical `release` stops; repeat press emits nothing; settings changes/dispose close the monitor. Installation failure reports unavailable and leaves a usable toggle fallback without starting two sessions.

- [ ] **Step 2: Run trigger tests and verify RED**

Run: `bun run test:desktop test/global-dictation-stream.test.ts test/voice-settings.test.tsx`.
Expected: no trigger setting or hold-monitor integration.

- [ ] **Step 3: Implement mode selection and single-owner registration**

Read the trigger with other sync settings, tear down the previous trigger before switching, and keep exactly one main trigger owner. Add a two-option control beside the existing shortcut capture with localized labels/descriptions; non-Windows hold selection reports unsupported rather than claiming success.

- [ ] **Step 4: Run desktop voice and native contract tests**

Run: `bun run test:desktop test/global-dictation-stream.test.ts test/global-dictation-target.test.ts test/dictation-hud.test.tsx test/voice-settings.test.tsx` and `bun run test` from `packages/natives`.
Expected: all pass.

- [ ] **Step 5: Commit Task 6**

Commit Task 6 files as `feat(voice): add hold-to-talk global dictation`.

### Task 7: Documentation and delivery verification

**Files:**
- Modify: `docs/gui-implementation.md`
- Modify: `docs/gui-implementation.zh-CN.md`
- Modify: `docs/gui-implementation.i18n.yaml` through pairing verification
- Modify: `docs/gui-design.md` and `docs/gui-design.zh-CN.md` only if Task 3 changed visible state contracts
- Modify: `packages/coding-agent/CHANGELOG.musepi.md`

**Interfaces:**
- Consumes: all prior behavior and exact verification results.

- [ ] **Step 1: Update bilingual behavior contracts and changelog**

Document internal/external routing, cumulative live previews, final-only injection, toggle/hold setting, Windows hold scope, failure fallback, and privacy boundary. Keep WeChat evidence in the design spec rather than turning living docs into investigation history.

- [ ] **Step 2: Run full affected tests and repository gates**

Run all STT/voice frontend tests, all desktop voice/dictation tests, all Composer tests, native tests, affected package checks, `scripts/check-package-boundaries.ts`, `scripts/verify-generated.ts`, docs/changelog checks, and named translation-pairing verification. Record unrelated pre-existing failures separately.

- [ ] **Step 3: Exercise the real Windows scenario**

Through the repository smoke harness, verify toggle inside/outside MusePi, hold press/release, cancellation, streamed HUD text, final-only external insertion, and no production session writes. External insertion must target a throwaway text editor owned by the harness, never an existing chat, document, or other user window. State plainly any microphone/global-shortcut behavior that cannot be exercised automatically.

- [ ] **Step 4: Commit documentation and verified fixes**

Commit only documentation and any review fixes with fresh RED→GREEN evidence as `docs(voice): document unified streaming dictation`.
