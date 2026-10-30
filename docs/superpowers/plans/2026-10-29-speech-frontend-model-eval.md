# Speech Front-End Model Evaluation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a reproducible local evaluation prototype that measures speaker verification, speech enhancement, and target-speaker extraction before integrating a candidate into MusePi.

**Architecture:** A TypeScript evaluation runner owns corpus parsing, gate decisions, ASR comparisons, and metrics. A persistent Python bridge owns research-model inference so candidate dependencies remain outside production packages; sherpa-onnx handles speaker embeddings inside the existing isolated speech runtime. This plan ends with a measured model-selection decision; daemon/GUI/TUI integration gets a follow-up plan based on the selected adapter.

**Tech Stack:** Bun, TypeScript, `bun:test`, existing `sherpa-onnx-node`, existing STT client, Python candidate bridge, ONNX Runtime/PyTorch only inside the ignored evaluation environment.

**Spec:** `docs/superpowers/specs/2026-10-29-target-speaker-voice-input-design.md`

## Global Constraints

- Do not commit, push, install production dependencies, or modify production voice behavior in this evaluation plan.
- Keep candidate repositories, virtual environments, models, generated audio, and metrics under `.tmp/speech-frontend-eval/`; never use production session or daemon storage.
- Run real STT/model checks through `bun scripts/dev-smoke.ts -- <command>`; use only public or explicitly supplied evaluation audio with transcripts and speaker labels.
- No audio, enrollment vectors, or transcript content in logs or persisted metrics. Metrics contain corpus item ids, scores, timing, memory, and model versions only.
- Required candidate targets: combined front-end RTF ≤ 0.75, endpoint front-end P95 ≤ 500 ms, added model downloads ≤ 300 MB, added resident memory ≤ 1 GB, and no non-target auto-submit in the fixed adversarial corpus.
- Clean-speech relative CER/WER regression must stay ≤ 2%; noise and overlap must each improve over the unprocessed baseline before a candidate can pass.
- Preserve unrelated worktree changes. Do not add a changelog entry for evaluation-only code.

## Review Focus

- Interferer-only audio must produce `reject`, never an empty-but-accepted result; pin this in Tasks 1 and 3.
- Short target speech below the verification window must produce `uncertain`, not `accept`; pin this in Task 3.
- A candidate that exits or returns malformed output must fail the current item without hanging later items; pin this in Task 2.
- Empty candidate output and sample-rate/length mismatches must be rejected rather than silently transcribed; pin this in Tasks 1 and 4.
- Model-load time, steady-state inference, and endpoint tail latency must remain separate measurements; pin this in Tasks 2 and 5.

---

### Task 1: Corpus and Metric Contract

**Files:**
- Create: `packages/coding-agent/src/stt/eval/corpus.ts`
- Create: `packages/coding-agent/src/stt/eval/metrics.ts`
- Create: `packages/coding-agent/test/stt-speech-eval-metrics.test.ts`

**Interfaces:**
- Produces: `AudioClip { samples: Float32Array; sampleRate: 16000 }`.
- Produces: `CorpusItem { id: string; kind: "clean" | "noise" | "interferer" | "overlap"; mixturePath: string; enrollmentPaths: string[]; transcript: string; targetMs: number }`.
- Produces: `loadCorpusManifest(path: string): Promise<CorpusItem[]>`, `levenshteinRate(reference: string, actual: string, unit: "char" | "word"): number`, `percentile(values: number[], p: number): number`, and `mixClips(target: AudioClip, interferer: AudioClip, targetGain: number, interfererGain: number): AudioClip`.

- [ ] **Step 1: Write failing contract tests**

Cover manifest rejection of unknown kinds, missing audio, non-16-kHz clips, and duplicate ids. Cover char/word error rates with Chinese and English, P50/P95 with unsorted input, overlap mixing without integer clipping, and the explicit expectation that an interferer-only item has `targetMs: 0`.

- [ ] **Step 2: Run the tests and confirm the intended failure**

Run: `bun test packages/coding-agent/test/stt-speech-eval-metrics.test.ts`
Expected: FAIL because the evaluation modules do not exist.

- [ ] **Step 3: Implement the corpus and metric modules**

Use JSONL for the corpus manifest and normalized float PCM in memory. Reuse `encodeWav` from `src/tts/wav.ts` for generated fixtures; do not add an audio dependency. `levenshteinRate` returns substitutions + insertions + deletions divided by reference units and rejects an empty reference.

- [ ] **Step 4: Run focused tests and package checks**

Run: `bun test packages/coding-agent/test/stt-speech-eval-metrics.test.ts && bun run --cwd=packages/coding-agent check`
Expected: PASS with no type or lint errors.

### Task 2: Persistent Candidate Bridge and Timing

**Files:**
- Create: `packages/coding-agent/src/stt/eval/candidate.ts`
- Create: `packages/coding-agent/src/stt/eval/external-candidate.ts`
- Create: `packages/coding-agent/scripts/speech-frontend-candidate.py`
- Create: `packages/coding-agent/test/stt-speech-eval-candidate.test.ts`

**Interfaces:**
- Produces: `CandidateRequest { id: string; mixturePath: string; enrollmentPaths: string[] }`.
- Produces: `CandidateResult { id: string; audioPath: string | null; sampleRate: number; loadMs: number; inferenceMs: number; rssBytes: number }`.
- Produces: `SpeechCandidate { prepare(): Promise<{ loadMs: number; rssBytes: number }>; extract(request: CandidateRequest): Promise<CandidateResult>; close(): Promise<void> }`.
- Produces: `createExternalCandidate(options: { implementation: string; python: string; workDir: string }): SpeechCandidate`.

- [ ] **Step 1: Write failing bridge tests with a fake Python candidate**

Assert one process serves multiple requests, model `loadMs` is reported only by `prepare`, malformed JSON and unknown response ids reject the current request, nonzero exit rejects pending requests, and `close()` reaps the child. Include a null-audio response for interferer-only input.

- [ ] **Step 2: Run the tests and confirm the intended failure**

Run: `bun test packages/coding-agent/test/stt-speech-eval-candidate.test.ts`
Expected: FAIL because the candidate adapter does not exist.

- [ ] **Step 3: Implement the JSONL bridge**

Use `Bun.spawn()` without a shell. The Python bridge supports `passthrough` and returns protocol-clean JSONL on stdout; diagnostics stay on stderr. Requests and responses use the interfaces above, inference is serialized, and Python reports its own RSS without adding a production package.

- [ ] **Step 4: Run bridge tests and a real passthrough smoke**

Run: `bun test packages/coding-agent/test/stt-speech-eval-candidate.test.ts`
Expected: PASS, including child cleanup on Windows.

### Task 3: Speaker Verification and Three-State Gate

**Files:**
- Modify: `packages/coding-agent/src/stt/sherpa-runtime.ts`
- Create: `packages/coding-agent/src/stt/eval/speaker-verifier.ts`
- Create: `packages/coding-agent/src/stt/eval/gate.ts`
- Create: `packages/coding-agent/scripts/speech-frontend-eval.ts`
- Create: `packages/coding-agent/test/stt-speech-eval-gate.test.ts`
- Create: `packages/coding-agent/test/stt-speech-eval-sherpa-contract.test.ts`

**Interfaces:**
- Produces: `SpeakerVerifier { embed(clip: AudioClip): Promise<Float32Array>; close(): Promise<void> }`.
- Produces: `GateDecision { state: "accept" | "uncertain" | "reject"; score: number | null; autoSubmit: boolean }`.
- Produces: `decideGate(input: { targetMs: number; score: number | null; acceptThreshold: number; rejectThreshold: number }): GateDecision`.
- Consumes: `AudioClip` from Task 1; extracted audio from Task 2 is converted back to `AudioClip` before verification.

- [ ] **Step 1: Write failing gate and runtime-contract tests**

Pin these decisions: `targetMs < 1000` → `uncertain`; `targetMs === 0` → `reject` with `autoSubmit: false`; score below the reject threshold → `reject`; between thresholds → `uncertain`; at or above accept threshold → `accept`. Only `accept` can set `autoSubmit: true`. Add runtime tests proving the speaker extractor is loaded lazily and closed independently of ASR.

- [ ] **Step 2: Run the tests and confirm the intended failure**

Run: `bun test packages/coding-agent/test/stt-speech-eval-gate.test.ts packages/coding-agent/test/stt-speech-eval-sherpa-contract.test.ts`
Expected: FAIL because the gate and speaker runtime surface do not exist.

- [ ] **Step 3: Implement verification and gate logic**

Inspect the installed `sherpa-onnx-node@1.13.2` declarations before extending `SherpaRuntime`; do not guess its API. Use the official 16-kHz 3D-Speaker/ERes2Net ONNX model for the first Chinese/English candidate, normalize embeddings, and compare with cosine similarity. Add the `--verify-only` path to `speech-frontend-eval.ts`; it prints raw scores without a gate decision. Accept/reject thresholds are required for the full benchmark, with no invented defaults.

- [ ] **Step 4: Run focused tests and a real model smoke**

Run: `bun test packages/coding-agent/test/stt-speech-eval-gate.test.ts packages/coding-agent/test/stt-speech-eval-sherpa-contract.test.ts`
Expected: PASS.
Run: `bun scripts/dev-smoke.ts -- bun packages/coding-agent/scripts/speech-frontend-eval.ts --verify-only --corpus .tmp/speech-frontend-eval/corpus.jsonl`
Expected: real embeddings and gate scores print without audio or transcript content.

### Task 4: Extraction and Enhancement Candidates

**Files:**
- Modify: `packages/coding-agent/scripts/speech-frontend-candidate.py`
- Create: `packages/coding-agent/src/stt/eval/audio-validation.ts`
- Create: `packages/coding-agent/test/stt-speech-eval-audio-validation.test.ts`

**Interfaces:**
- Consumes: `SpeechCandidate`, `CandidateRequest`, and `CandidateResult` from Task 2.
- Produces: `validateCandidateAudio(result: CandidateResult, expected: { sampleRate: number; durationMs: number; maxDurationDeltaMs: number }): Promise<AudioClip | null>`.
- Supports candidate ids `openspeakerbeam`, `clearvoice-speakerbeam`, and `dpdfnet` in addition to `passthrough`.

- [ ] **Step 1: Write failing audio-validation tests**

Cover empty audio, wrong sample rate, NaN samples, duration mismatch over 100 ms, and a valid null-audio rejection. Valid 16-kHz output returns a normalized `AudioClip`.

- [ ] **Step 2: Run the tests and confirm the intended failure**

Run: `bun test packages/coding-agent/test/stt-speech-eval-audio-validation.test.ts`
Expected: FAIL because validation does not exist.

- [ ] **Step 3: Implement candidates in the ignored research environment**

Use OpenSpeakerBeam-SS as the first 16-kHz single-channel extraction candidate, ClearerVoice's 8-kHz audio-only SpeakerBeam resampled to 16 kHz as a quality reference rather than a production candidate, and sherpa DPDFNet as the enhancement candidate. Record model/repository revisions and licenses. Do not use binaural Look Once to Hear or audio-visual models for the single-microphone contract. Candidate setup stays under `.tmp/speech-frontend-eval/` and does not change package manifests.

- [ ] **Step 4: Run each candidate on the same public sample set**

Run through the persistent bridge, not one process per clip. Confirm 16-kHz output or explicit rejection, stable lengths, finite samples, and no null output for target speech. Record cold load separately from per-item inference and RSS.

### Task 5: End-to-End Benchmark and Selection Gate

**Files:**
- Create: `packages/coding-agent/src/stt/eval/report.ts`
- Modify: `packages/coding-agent/scripts/speech-frontend-eval.ts`
- Create: `packages/coding-agent/test/stt-speech-eval-report.test.ts`

**Interfaces:**
- Consumes: all prior task interfaces and existing `sttClient.transcribe()` for baseline/processed ASR.
- Produces: `BenchmarkRow { itemId: string; kind: CorpusItem["kind"]; candidate: string; gate: GateDecision; cer: number | null; wer: number | null; audioMs: number; endpointMs: number; loadMs: number; inferenceMs: number; rssBytes: number }`.
- Produces: `summarizeBenchmark(rows: BenchmarkRow[]): { rtf: number; p95EndpointMs: number; cleanRelativeRegression: number | null; nonTargetAutoSubmits: number }`.

- [ ] **Step 1: Write failing report and acceptance tests**

Assert non-target auto-submits are counted even when ASR returns empty text, clean regression compares against the same item's unprocessed ASR, load time is excluded from steady-state RTF, and a failed candidate cannot overwrite another candidate's rows.

- [ ] **Step 2: Run the tests and confirm the intended failure**

Run: `bun test packages/coding-agent/test/stt-speech-eval-report.test.ts`
Expected: FAIL because reporting does not exist.

- [ ] **Step 3: Implement the benchmark CLI**

Accept `--corpus`, `--candidate`, `--accept-threshold`, `--reject-threshold`, and `--output`. Evaluate unprocessed and processed audio through the same STT model. Write JSON metrics without transcripts or embeddings. Exit nonzero when required corpus classes are missing or any candidate fails the spec's acceptance thresholds.

- [ ] **Step 4: Run all focused tests and checks**

Run: `bun test packages/coding-agent/test/stt-speech-eval-*.test.ts && bun run --cwd=packages/coding-agent check && bun run check:docs`
Expected: PASS.

- [ ] **Step 5: Run the real benchmark and decide the follow-up design**

Run through `bun scripts/dev-smoke.ts -- ...` on clean, noise, interferer-only, and overlap corpora. Record actual hardware, candidate revisions, RTF, P95, RSS, FAR/FRR, CER/WER, and download sizes. If a candidate passes, write the daemon/GUI/TUI integration plan around that adapter. If none passes, stop before product integration and report the measured blocker rather than substituting simple voiceprint gating for the requested overlap handling.
