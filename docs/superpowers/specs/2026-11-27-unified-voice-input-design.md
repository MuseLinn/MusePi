# Unified streaming dictation design

## Intent

MusePi should behave as one dictation service with two presentation contexts. When a MusePi composer owns focus, the global shortcut drives that composer directly and no global HUD appears. When another application owns focus, the same shortcut drives the non-focusable HUD, live transcription remains visible, and only final text is injected into the foreground application. Toggle shortcut support lands first, then hold-to-talk with release-to-finish.

## Evidence

Static analysis of Weixin 4.2.1.11 found a shared `VoiceInputUIService`, separate focus/global keyboard listeners, internal field and external window views, and `XEditorAppVoiceInputBridge` composition start/update/end callbacks. Shipped configuration distinguishes toggle and hold shortcuts. These observations motivate the architecture; MusePi does not copy WeChat code or visual assets.

Craft Anything findings `fnd_2` and `fnd_3` record the target identity, offsets, and limits. REA did not recover the native WeChat keyup call chain before the Ghidra startup deadline, so the native listener design below is a MusePi design choice rather than a recovered WeChat implementation.

## Goals

- Reuse the existing `voice.frontendStream*` session and sentence-level ASR finals in both contexts.
- Show cumulative finalized text plus the active preview in the external HUD.
- Route the global accelerator to a focused MusePi composer without showing the HUD.
- Inject text into another application only after the stream finishes successfully.
- Preserve cancellation, error reporting, microphone cleanup, model download, and foreground focus.
- Add a hold-shortcut monitor whose physical key release finishes the same session.
- Keep keyboard observation scoped to the configured chord, pass every event through, and never log transcript text or unrelated keys.

## Non-goals and anti-goals

- Do not change the sentence-level ASR algorithm delivered by the preceding task.
- Do not clone WeChat artwork, layout, or proprietary code.
- Do not type volatile previews into external applications.
- Do not maintain separate ASR sessions for the internal and external surfaces.
- Do not swallow global keyboard events or install an always-on listener when dictation is disabled.
- Do not claim macOS hold-shortcut parity from a Windows implementation.

## Approaches

### Approved sequence: A then B

A first implements shared streaming, internal routing, and external live previews using Electron's existing toggle accelerator. B then extends the existing native low-level keyboard infrastructure with a scoped press/release monitor and routes both trigger styles into the same session controller.

This sequence separates transport/UI regressions from native keyboard regressions and gives each stage an independently testable checkpoint.

### Rejected alternatives

- Styling alone: hiding the HUD inside MusePi without changing the global one-shot transcription path would leave the main behavioral gap intact.
- Full native rewrite first: adding key hooks while global dictation still buffers one-shot audio would make failures difficult to localize.
- Renderer-only key polling: Electron `globalShortcut` has no keyup callback, and renderer focus cannot observe release while another application owns focus.

## Stage A: shared stream and route

### Main-process controller

`GlobalDictation` remains the owner of the external session, HUD, native capture, and final text injection. It loads the configured model, language, speaker mode, and enhancement settings, starts `voice.frontendStreamStart`, serializes audio RPCs, and consumes partial/segment events by session id.

The HUD receives a cumulative display transcript assembled from finalized sentence results and the current partial. Stop waits for queued audio, calls `voice.frontendStreamStop`, and uses the returned final transcript. Empty, failed, cancelled, or stale sessions never inject text. The recording limit aligns with the streaming worker instead of the old 30-second one-shot limit.

### Internal target routing

A narrow preload bridge reports whether an eligible composer in the focused MusePi window can accept the global accelerator and delivers toggle events to that composer. `useDictation` registers its toggle and focus state; multiple composers resolve only by actual DOM focus. The main process routes internally only when both the focused window and registered target agree. Otherwise it starts or stops the external controller.

Internal dictation uses the existing composer preview/final replacement and voice state styling. No global HUD is created for this route. Losing focus or unmounting invalidates the registration without cancelling an already active dictation implicitly.

## Stage B: hold shortcut

Extend the existing native Windows keyboard-hook ownership pattern with a dedicated dictation shortcut monitor. It observes physical press/release for the configured hold chord, ignores injected events and auto-repeat, forwards every event, and reports only chord transitions. Start installs the monitor only when hold mode is enabled; disposal wakes and joins its thread before unloading native code.

The main process treats a first physical press as start and the corresponding release as stop. Cancel, microphone failure, settings changes, and application shutdown invalidate the held generation. If the monitor cannot install, MusePi reports the error and retains the toggle shortcut rather than silently pretending hold mode works.

Other platforms keep toggle behavior until their own native monitor is implemented and verified.

## Testing and verification

- Main-process unit tests cover streamed event aggregation, audio ordering, stale sessions, empty/error stops, final-only injection, and internal/external routing.
- Renderer tests cover focus registration, multiple composers, toggle delivery, unmount, and existing preview/final replacement.
- GUI probes verify the composed internal border/button state and external HUD with realistic partial text.
- Native tests cover press, repeat, release, injected-event filtering, unrelated keys, cancellation, and teardown.
- Focused package checks precede the affected full suites, package-boundary/generated checks, and real Windows microphone/global-shortcut smoke runs.
- Stage A and Stage B have separate scoped local commits. Neither stage is pushed.

## Documentation

Update the owning GUI implementation and design documents in both locales when behavior lands, plus the coding-agent changelog where user-visible desktop behavior is tracked. Record any unverified native platform behavior and preserve unrelated worktree changes.

## Builder-settled details

- The existing `dictation.globalShortcut` remains the toggle accelerator; hold mode needs a separate setting so users can choose either interaction without ambiguity.
- Existing HUD styling remains the visual base; WeChat contributes architectural evidence, not design assets.
- A failed internal registration falls back to the external controller rather than dropping the user's shortcut invocation.
