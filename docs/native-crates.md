# Native Crates

Contributor map for the Rust workspace members under `crates/`. These crates back
`@musepi/pi-natives` and the embedded shell/PTY runtime. They are intentionally
internal: package consumers use the JavaScript entrypoints, not these crate APIs.

The root `Cargo.toml` includes `crates/pi-*` and `crates/vendor/*` as workspace
members. It also patches crates.io `brush-core` to the vendored copy. A directory
being a workspace member does not by itself mean `pi-natives` exposes it as a
JavaScript API.

## First-party crates

| Crate | Path | Role |
| --- | --- | --- |
| `pi-natives` | [`crates/pi-natives`](../crates/pi-natives) | Top-level N-API `cdylib`; exposes the JS-visible API and depends on `pi-ast`, `pi-iso`, `pi-shell`, `pi-voice`, and `pi-walker`. |
| `pi-builtins` | [`crates/pi-builtins`](../crates/pi-builtins) | Every builtin the embedded shell installs: a patched fork of brush's POSIX/bash builtins, plus one module per in-process command-line utility (`cat`, `grep`/`rg`, `sed`, `ls`, `find`, `jq`, `fd`, `diff`, `ps`, `top`, `kill`, the moreutils set, …). `crates/pi-builtins/src/host.rs` holds the `Utility` trait and the `Host` view of the shell (stdio, working directory, exported environment, cancellation) that utilities run against. Ports of uutils coreutils/findutils/sed and jaq live here too; see the crate `LICENSE` for third-party notices. |
| `pi-shell` | [`crates/pi-shell`](../crates/pi-shell) | Persistent embedded brush shell, command execution/minimization, process plumbing, filesystem walking, and in-process command integration used by `pi-natives`. |
| `pi-voice` | [`crates/pi-voice`](../crates/pi-voice) | Cross-platform microphone/playback and Opus/WebRTC support used by the `AudioCapture`, `AudioPlayback`, and `LiveWebRtcPeer` bindings. |
| `pi-ast` | [`crates/pi-ast`](../crates/pi-ast) | tree-sitter/ast-grep language registry, matching/editing, block analysis, and summarization across the workspace grammar set. |
| `pi-iso` | [`crates/pi-iso`](../crates/pi-iso) | Task isolation backends and diffing: APFS clones, btrfs/zfs reflinks, overlayfs, ProjFS, and recursive-copy fallback. |
| `pi-walker` | [`crates/pi-walker`](../crates/pi-walker) | Parallel, cache-aware filesystem walker using ignore rules and globsets; shared by native grep/glob/workspace paths and shell commands. |

## Vendored workspace crates

| Group | Paths | Purpose |
| --- | --- | --- |
| Brush | [`crates/vendor/brush-core`](../crates/vendor/brush-core) | Vendored fork of [brush-shell](https://github.com/reubeno/brush) for embedded bash execution, consumed by `pi-shell` and `pi-builtins`. Its manifest retains upstream package metadata; a workspace patch selects this local fork. |

`pi_builtins::utility_builtins()` and `pi_builtins::process_builtins()` are the
authoritative lists of the commands linked into the embedded shell; `pi-shell`
decides which of them to register.

## Boundary map

```text
@musepi/pi-natives JS entrypoints
  -> pi-natives (N-API conversion, platform bindings, task boundaries)
       -> pi-ast / pi-iso / pi-voice / pi-walker
       -> pi-shell
            -> brush-core (parser, expansion, interpreter)
            -> pi-builtins (bash builtins + utility builtins; host.rs: per-invocation I/O and cwd)
```

## What lives where

- Native API surface and loader (`@musepi/pi-natives`):
  [`natives-architecture.md`](./natives-architecture.html),
  [`natives-addon-loader-runtime.md`](./natives-addon-loader-runtime.html),
  [`natives-binding-contract.md`](./natives-binding-contract.html),
  [`natives-build-release-debugging.md`](./natives-build-release-debugging.html),
  [`natives-media-system-utils.md`](./natives-media-system-utils.html),
  [`natives-rust-task-cancellation.md`](./natives-rust-task-cancellation.html),
  [`natives-shell-pty-process.md`](./natives-shell-pty-process.html),
  [`natives-text-search-pipeline.md`](./natives-text-search-pipeline.html).
- Filesystem scan cache contract that consumes `pi-walker`:
  [`fs-scan-cache-architecture.md`](./fs-scan-cache-architecture.html).
- Porting cross-references:
  [`porting-from-pi-mono.md`](./porting-from-pi-mono.html),
  [`porting-to-natives.md`](./porting-to-natives.html).

## Policy

These crates are implementation details. End-user docs live with the consuming
package (`@musepi/pi-natives`) and the architecture pages above. Promote a crate
to a dedicated user-facing doc only when it grows a standalone CLI or public API
consumed outside `packages/natives`; see
[`user-facing-packages.md`](./user-facing-packages.html).
