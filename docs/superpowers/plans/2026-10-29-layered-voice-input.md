# Layered Voice Input Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add opt-in neural VAD, DPDFNet enhancement, and local speaker verification with conservative submission semantics to MusePi's desktop and TUI dictation.

**Architecture:** A dedicated voice-front-end worker owns Silero VAD, DPDFNet, and speaker embeddings, while the daemon owns enrollment profiles and mode settings. Desktop batch dictation and TUI streaming dictation consume the same three-state gate before existing ASR; no target-speaker extraction is introduced.

**Tech Stack:** Bun, TypeScript, React, existing sherpa-onnx worker/runtime, `bun:test`, DialogFrame/Reveal/HeightMorph/morphicons.

**Spec:** `docs/superpowers/specs/2026-10-29-layered-voice-input-design.md`

## Global Constraints

- Default `stt.speakerMode` is `off`; `stt.enhanceAudio` defaults to false. Existing behavior remains unchanged until the user opts in.
- No target-speaker extraction, new production package dependency, cloud speech service, or required GPU.
- Store embeddings only: no raw enrollment audio, transcripts, or vectors in logs, sessions, analytics, or synced config.
- `prefer`: `accept` allows normal transcription and existing submit trigger; `uncertain` allows draft only; `reject` drops audio. `strict`: only `accept` reaches ASR.
- Keep real-time audio callbacks free of model inference, I/O, and lock waits; front-end RTF ≤ 0.75 and stream-tail P95 ≤ 500 ms excluding ASR.
- Preserve unrelated changes. Do not commit, merge, push, or install production dependencies.
- User-facing behavior updates both locales of owning docs and `CHANGELOG.musepi.md` under `[Unreleased]` with inline English.
- Tests and real-model smoke runs use isolated agent/daemon directories and `scripts/dev-smoke.ts`.

## Review Focus

- Interferer-only audio must never auto-submit, even if ASR returns empty text; pin this in Tasks 1, 3, and 6.
- Short target speech below 1000 ms must be `uncertain`, never `accept`; pin this in Task 1.
- Failed or canceled enrollment must preserve the previous valid profile and remove temporary audio/state; pin this in Tasks 2 and 4.
- Worker/model failure must not silently produce unverified output or falsely report enhanced audio; pin this in Tasks 1 and 5.
- Reduced-motion enrollment must retain equivalent progress and error information without animation; pin this in Task 4.

---

### Task 1: Front-End Worker and Three-State Processing

**Files:**
- Create: `packages/coding-agent/src/voice/frontend/models.ts`
- Create: `packages/coding-agent/src/voice/frontend/gate.ts`
- Create: `packages/coding-agent/src/voice/frontend/protocol.ts`
- Create: `packages/coding-agent/src/voice/frontend/worker.ts`
- Create: `packages/coding-agent/src/voice/frontend/client.ts`
- Modify: `packages/coding-agent/src/stt/sherpa-runtime.ts`
- Modify: `packages/coding-agent/src/cli.ts`
- Create: `packages/coding-agent/test/voice-frontend-gate.test.ts`
- Create: `packages/coding-agent/test/voice-frontend-client.test.ts`

**Interfaces:**
- Produces: `SpeakerMode = "off" | "prefer" | "strict"` and `GateState = "accept" | "uncertain" | "reject"`.
- Produces: `FrontendProcessResult { segmentId: number; audio: Float32Array; state: GateState; score: number | null; enhanced: boolean }`.
- Produces: `VoiceFrontendClient.process(input: { audio: Float32Array; sampleRate: 16000; targetMs: number; speakerMode: SpeakerMode; enhanceAudio: boolean; enrollment: Float32Array[]; acceptThreshold: number; rejectThreshold: number }): Promise<FrontendProcessResult>`.
- Produces: `VoiceFrontendClient.embed(audio: Float32Array, sampleRate: 16000): Promise<Float32Array>` and worker messages `process`, `embed`, `ping`, with outbound `result`, `embedding`, `pong`, `error`; `close()` terminates the child.
- Consumes: 3D-Speaker/ERes2Net embeddings and DPDFNet through the existing sherpa runtime.

- [ ] **Step 1: Write failing gate and client lifecycle tests**

Pin `targetMs === 0` → reject, `<1000` → uncertain, below/within/above thresholds, `off` pass-through with no speaker model load, DPDFNet not marked enhanced when disabled or failed, process cleanup, and unknown response ids. Test the real client with a fake worker transport before loading native models.

- [ ] **Step 2: Run tests and confirm failure**

Run: `bun test packages/coding-agent/test/voice-frontend-gate.test.ts packages/coding-agent/test/voice-frontend-client.test.ts`
Expected: FAIL because the front-end modules do not exist.

- [ ] **Step 3: Implement model registry, gate, protocol, client, and worker**

Register Silero VAD, DPDFNet2, and ERes2Net model files with atomic downloads. Use the existing worker host and runtime installer. Process VAD segments with pre-roll, optional DPDFNet, and cosine verification. `prefer` and `strict` share gate calculation; their different ASR behavior is enforced by callers. Return `enhanced: false` when enhancement is disabled or fails.

- [ ] **Step 4: Run focused tests and a real worker smoke**

Run: `bun test packages/coding-agent/test/voice-frontend-gate.test.ts packages/coding-agent/test/voice-frontend-client.test.ts && bun run --cwd=packages/coding-agent check`
Expected: PASS. Run a real public-speech `process` smoke through `scripts/dev-smoke.ts` and confirm 16-kHz output, score, and cleanup.

### Task 2: Local Enrollment Profile Store

**Files:**
- Create: `packages/coding-agent/src/voice/frontend/profile.ts`
- Create: `packages/coding-agent/test/voice-speaker-profile.test.ts`

**Interfaces:**
- Produces: `SpeakerProfile { version: 1; model: string; dimension: number; samples: number[][]; centroid: number[]; acceptThreshold: number; rejectThreshold: number }`.
- Produces: `startEnrollment(): EnrollmentState`, `addEnrollmentSample(audio: Float32Array, sampleRate: 16000): Promise<{ accepted: boolean; reason?: string; count: number }>`, `finishEnrollment(verificationAudio: Float32Array, sampleRate: 16000): Promise<{ ok: boolean; score?: number; error?: string }>`, `cancelEnrollment(): void`, `readSpeakerProfile(): Promise<SpeakerProfile | null>`, and `deleteSpeakerProfile(): Promise<void>`.
- Consumes: `VoiceFrontendClient.embed(audio, sampleRate)` from Task 1.

- [ ] **Step 1: Write failing profile state tests**

Use a fake embedder with controlled vectors. Cover four accepted clips, <16-second total rejection, inconsistent clip rejection, independent verification threshold, cancellation preserving the previous profile, delete removing the file, and no raw audio fields in persisted JSON.

- [ ] **Step 2: Run tests and confirm failure**

Run: `bun test packages/coding-agent/test/voice-speaker-profile.test.ts`
Expected: FAIL because the profile store does not exist.

- [ ] **Step 3: Implement the profile state machine and private file storage**

Store under the current user's agent voice directory with user-only permissions. Commit a new profile only after independent verification succeeds; retain the old profile on every failure. Persist embeddings and model metadata only.

- [ ] **Step 4: Run tests and package checks**

Run: `bun test packages/coding-agent/test/voice-speaker-profile.test.ts && bun run --cwd=packages/coding-agent check`
Expected: PASS.

### Task 3: Daemon Voice RPC and Settings

**Files:**
- Modify: `packages/coding-agent/src/config/settings-schema.ts`
- Modify: `packages/coding-agent/src/daemon/server.ts`
- Create: `packages/coding-agent/src/voice/frontend/service.ts`
- Modify: `packages/wire/src/index.ts`
- Create: `packages/coding-agent/test/daemon/voice-frontend-rpc.test.ts`
- Create: `packages/wire/test/voice-frontend-contract.test.ts`

**Interfaces:**
- Produces settings `stt.speakerMode` and `stt.enhanceAudio` with the defaults above.
- Produces RPC `voice.speakerStatus`, `voice.speakerEnrollmentStart`, `voice.speakerEnrollmentAdd`, `voice.speakerEnrollmentFinish`, `voice.speakerEnrollmentCancel`, and `voice.speakerDelete`.
- Produces `voice.frontendProcess` returning `{ audio: number[]; state: GateState; score: number | null; enhanced: boolean }`.
- Produces streaming RPC `voice.frontendStreamStart`, `voice.frontendStreamAudio`, `voice.frontendStreamStop`, and `voice.frontendStreamCancel`, plus events `voice.frontendPartial { sessionId, segmentId, text, state }` and `voice.frontendSegment { sessionId, segmentId, text, state }`.

- [ ] **Step 1: Write failing RPC and wire tests**

Cover unknown enrollment calls, invalid sample rate/audio, per-clip progress, finish/cancel/delete, status after restart, and `frontendProcess` mode/threshold forwarding. Verify partial/segment session filtering and cancel preventing late events. Interferer-only input must not produce auto-submit behavior.

- [ ] **Step 2: Run tests and confirm failure**

Run: `bun test packages/coding-agent/test/daemon/voice-frontend-rpc.test.ts packages/wire/test/voice-frontend-contract.test.ts`
Expected: FAIL because routes and wire contracts do not exist.

- [ ] **Step 3: Implement the shared daemon service, RPC routes, settings, and stream events**

Use one service/client per daemon, serialize enrollment, and expose only numeric audio and gate metadata. Keep streaming sessions bounded and ordered; cancellation invalidates future events. Validate all wire payloads and avoid logging embeddings or transcripts.

- [ ] **Step 4: Run RPC, wire, and package checks**

Run: `bun test packages/coding-agent/test/daemon/voice-frontend-rpc.test.ts packages/wire/test/voice-frontend-contract.test.ts && bun run --cwd=packages/coding-agent check && bun run --cwd=packages/wire check`
Expected: PASS.

### Task 4: Desktop Streaming Dictation and Enrollment UI

**Files:**
- Modify: `packages/desktop-app/src/lib/voice.ts`
- Modify: `packages/desktop-app/src/components/composer/use-dictation.ts`
- Modify: `packages/desktop-app/src/components/composer/action-buttons.tsx`
- Modify: `packages/desktop-app/src/styles/gui-composer.css`
- Create: `packages/desktop-app/src/components/composer/speaker-enrollment.tsx`
- Modify: `packages/desktop-app/src/components/settings-sections/voice.tsx`
- Modify: `packages/desktop-app/src/i18n/voice.ts`
- Create: `packages/desktop-app/test/speaker-enrollment.test.tsx`
- Create: `packages/desktop-app/test/voice-streaming-dictation.test.ts`
- Modify: `packages/desktop-app/src/lib/voice.test.ts`

**Interfaces:**
- Consumes: all Task 3 RPCs, stream events, and `GateState`.
- `startDictationOpts` handles `accept` normally, `uncertain` through `onReview`, and `reject` without transcription; `onPartial(text)` updates volatile preview only.
- `VoiceStatusStrip` renders `partialText?: string` and actual RMS/state without shifting the composer.
- Enrollment component uses four prompts plus independent verification and exposes start/retry/finish/cancel/delete.

- [ ] **Step 1: Write failing desktop behavior tests**

Cover partial preview not committing text, final segment insertion, `prefer` draft-only review, `strict` rejection, `off` unchanged submit behavior, cancellation preventing late partials, four-clip wizard progress, retry preserving completed clips, and `gui-motion-off` retaining textual progress/errors. Assert stable strip geometry and no unnecessary secondary labels.

- [ ] **Step 2: Run tests and confirm failure**

Run: `bun test packages/desktop-app/test/voice-streaming-dictation.test.ts packages/desktop-app/test/speaker-enrollment.test.tsx packages/desktop-app/src/lib/voice.test.ts`
Expected: FAIL because streaming dictation and the wizard do not exist.

- [ ] **Step 3: Implement streaming RPC wiring, volatile preview, and reactive motion**

Feed PCM chunks to the front-end stream while recording. Show `partial` only as temporary preview and `segment` as committed text, preserving cancellation and stale-session guards. Use layered RMS-driven rings/waves/glow, reserved preview space, and motion-off equivalents. Keep current submit-trigger logic and add only necessary status copy. Use `DialogFrame`, `Reveal`/`HeightMorph`, and `morphicons` for enrollment.

- [ ] **Step 4: Run desktop tests, checks, and real UI verification**

Run: `bun test packages/desktop-app/test/voice-streaming-dictation.test.ts packages/desktop-app/test/speaker-enrollment.test.tsx packages/desktop-app/src/lib/voice.test.ts && bun run --cwd=packages/desktop-app check`
Expected: PASS. Verify in Electron: live partial text, final insertion, error retry, completion, stable layout, reduced motion, and Escape cleanup.

### Task 5: TUI Streaming Integration

**Files:**
- Modify: `packages/coding-agent/src/voice/frontend/client.ts`
- Modify: `packages/coding-agent/src/voice/frontend/protocol.ts`
- Modify: `packages/coding-agent/src/voice/frontend/worker.ts`
- Modify: `packages/coding-agent/src/stt/stt-controller.ts`
- Create: `packages/coding-agent/test/voice-frontend-stream.test.ts`
- Create: `packages/coding-agent/test/stt-speaker-mode.test.ts`

**Interfaces:**
- Adds `VoiceFrontendClient.startStream(options): { pushAudio(samples): void; stop(): Promise<FrontendProcessResult[]>; cancel(): void }` shared with the desktop RPC stream.
- `STTController` forwards only allowed audio to the existing ASR stream and tracks whether any `uncertain` segment disables auto-submit.

- [ ] **Step 1: Write failing streaming and controller tests**

Cover out-of-order segment delivery, cancel preventing late text, short-segment uncertainty, strict rejection, prefer draft-only, worker failure not treated as enhanced, and off-mode unchanged streaming.

- [ ] **Step 2: Run tests and confirm failure**

Run: `bun test packages/coding-agent/test/voice-frontend-stream.test.ts packages/coding-agent/test/stt-speaker-mode.test.ts`
Expected: FAIL because the streaming path does not exist.

- [ ] **Step 3: Implement bounded streaming sessions and STTController integration**

Keep queues bounded and sequence results by segment id. Do not run inference on the native audio callback. Preserve pre-roll, cancel, and stale-session guards; do not change ASR or submit-trigger contracts.

- [ ] **Step 4: Run focused tests and a real TUI smoke**

Run: `bun test packages/coding-agent/test/voice-frontend-stream.test.ts packages/coding-agent/test/stt-speaker-mode.test.ts && bun run --cwd=packages/coding-agent check`
Expected: PASS. Exercise real microphone start/stop/cancel in an isolated TUI session and confirm no late transcript.

### Task 6: End-to-End Acceptance and Documentation

**Files:**
- Modify: `packages/coding-agent/CHANGELOG.musepi.md`
- Modify: `docs/gui-design.md`
- Modify: `docs/gui-design.zh-CN.md`
- Modify: `docs/gui-implementation.md`
- Modify: `docs/gui-implementation.zh-CN.md`
- Modify: `docs/superpowers/specs/2026-10-29-layered-voice-input-design.md` (mark approved after acceptance)
- Create: `packages/coding-agent/scripts/voice-frontend-smoke.ts`
- Create: `packages/coding-agent/test/voice-frontend-acceptance.test.ts`

**Interfaces:**
- Real smoke consumes public or synthetic clean, noise, interferer, and overlap audio and emits metrics without transcripts or embeddings.

- [ ] **Step 1: Add the real acceptance fixture and threshold test**

Assert no non-target auto-submits, clean relative CER/WER regression ≤ 2%, front-end RTF ≤ 0.75, and tail P95 ≤ 500 ms. Include a short utterance and an enhancement-disabled baseline.

- [ ] **Step 2: Run real acceptance and record hardware metrics**

Run through `scripts/dev-smoke.ts`. If a metric fails, report it without changing the fixture or threshold to force a pass. Confirm off/prefer/strict behavior end to end.

- [ ] **Step 3: Complete bilingual docs and changelog**

Document the layered pipeline, opt-in modes, local-only embeddings, enrollment motion, fallback behavior, and performance evidence. Do not mention target extraction as shipped.

- [ ] **Step 4: Run final verification**

Run: `bun test packages/coding-agent/test/voice-*.test.ts packages/coding-agent/test/stt-*.test.ts packages/desktop-app/test/speaker-enrollment.test.tsx packages/desktop-app/src/lib/voice.test.ts && bun run --cwd=packages/coding-agent check && bun run --cwd=packages/desktop-app check && bun run check:docs`
Expected: PASS. Then run the full coding-agent suite and classify any unrelated or environment failures separately.
