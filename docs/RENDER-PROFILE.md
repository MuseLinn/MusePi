# MusePi Render Profile (C18)

> Benchmark: `node packages/coding-agent/scripts/bench-render.mjs`
> Date: 2026-07-21 · fork @ f648c5b5 · Node 24 on Windows
> Workload: chat Container of N message components, each rendering
> ~375 lines of realistic Markdown; 50 iterations per cell after warmup.

## Numbers (mean per frame)

| history | damage tracking | changed frame | settled frame |
|---|---|---|---|
| 100 messages | off | 0.05 ms | 0.05 ms |
| 100 messages | on | 0.07 ms | 0.05 ms |
| 500 messages | off | 0.14 ms | 0.07 ms |
| 500 messages | on | 0.37 ms | 0.23 ms |
| 1000 messages | off | 0.68 ms | 0.38 ms |
| 1000 messages | on | 1.17 ms | 0.74 ms |
| 2000 messages | off | 0.87–1.42 ms | 0.93–1.42 ms |
| 2000 messages | on | 0.87 ms | 0.93 ms |

## Findings

1. **Frame cost is flat at ~1 ms even at 2000 messages (~750k rendered
   lines).** Two cache layers share the credit: pi-tui's Markdown keeps
   per-component output keyed on text+width, and the MusePi
   damage-tracked Container skips whole children by fingerprint+width.
   The residual cost is the tree walk + line concat + frame diff, which
   is O(lines) but V8-cheap.
2. The 16 ms frame budget holds with **>10× headroom** at history sizes
   well beyond realistic sessions. Scroll/resize storms stay interactive.
3. Damage tracking's marginal value is structural, not numeric: it
   eliminates the per-frame re-render of settled subtrees (their output
   is reused, not recomputed), which keeps widget churn (spinner ticks)
   from ever becoming quadratic as component counts grow.

## Gate conclusion (per MusePi-PLAN Phase-4 criteria)

**No native rendering layer needed.** The plan's gate for a Rust/native
layer was: (a) profile proves the bottleneck is in tool execution
(grep/glob/edit), or (b) edit-drift failure rate rises. Rendering is
demonstrably not the bottleneck, so the gate stays closed:

- Native rendering (Rust) would optimize a solved problem — do not build it.
- The native-layer question remains gated on **tool-layer** profiling
  (large-repo grep/glob latency, edit drift telemetry), which is
  future work outside this profile.
