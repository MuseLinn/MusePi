# Native Crates

Contributor-facing map of the Rust crates under `crates/`. These crates back
`@musepi/pi-natives` and the embedded shell/PTY runtime. They are intentionally
internal: end users see `@musepi/pi-natives` exports, not these crate APIs.

For the consumer-side runtime contract see
[`natives-architecture.md`](./natives-architecture.html). For inclusion policy
covering when a crate should be promoted to user-facing docs, see
[`user-facing-packages.md`](./user-facing-packages.html).

## Crate map

| Crate | Path | Role |
| --- | --- | --- |
| `pi-natives` | [`crates/pi-natives`](../crates/pi-natives) | Top-level N-API `cdylib`; aggregates the other crates and exposes the JS-visible API. |
| `pi-shell` | [`crates/pi-shell`](../crates/pi-shell) | Embedded shell / PTY / process management split out of `pi-natives` (wraps `brush-*`). |
| `pi-ast` | [`crates/pi-ast`](../crates/pi-ast) | tree-sitter-based code summarizer and AST utilities; 50+ language grammars. |
| `pi-iso` | [`crates/pi-iso`](../crates/pi-iso) | Task isolation backend resolver: APFS clones, btrfs/zfs reflinks, overlayfs, projfs, rcopy. |
| `pi-walker` | [`crates/pi-walker`](../crates/pi-walker) | Parallel filesystem walker (ignore + globset) shared by grep, glob, and fs-scan cache. |
| `pi_uu_grep` | [`crates/pi-uu-grep`](../crates/pi-uu-grep) | `grep` re-implemented on `grep-regex` / `grep-searcher`; runs in-process as a shell builtin. Entry: `pi_uu_grep::run`. |
| `pi-uutils-ctx` | [`crates/pi-uutils-ctx`](../crates/pi-uutils-ctx) | Thread-local stdio + cwd context shim for embedding vendored uutils as in-process shell builtins. |
| `brush-core` | [`crates/vendor/brush-core`](../crates/vendor/brush-core) | Vendored fork of [brush-shell](https://github.com/reubeno/brush) for embedded bash execution. |
| `brush-builtins` | [`crates/vendor/brush-builtins`](../crates/vendor/brush-builtins) | Vendored bash builtins (`cd`, `echo`, `test`, `printf`, `read`, `export`, ...). |

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
- Porting cross-references:
  [`porting-from-pi-mono.md`](./porting-from-pi-mono.html),
  [`porting-to-natives.md`](./porting-to-natives.html).
- Filesystem scan cache contract that consumes `pi-walker`:
  [`fs-scan-cache-architecture.md`](./fs-scan-cache-architecture.html).

## Policy

These crates are implementation details. End-user docs live with the consuming
package (`@musepi/pi-natives`) and the architecture pages above. Promote a
crate to a dedicated user-facing doc only when it grows a standalone CLI or
public API consumed outside `packages/natives`.
Contributor map for Rust workspace members under `crates/`. They are implementation details behind `@musepi/pi-natives` and its embedded shell; package consumers use JavaScript entrypoints, not these crate APIs.

The root `Cargo.toml` includes `crates/pi-*` and `crates/vendor/*` as workspace members. It also patches crates.io `brush-core` to the vendored copy.

## First-party crates

| Crate           | Path                                              | Role and consumers                                                                                                                                              |
| --------------- | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pi-natives`    | [`crates/pi-natives`](../crates/pi-natives)       | Top-level N-API `cdylib`. It exposes the JS-visible API and depends on `pi-ast`, `pi-iso`, `pi-shell`, `pi-voice`, and `pi-walker`.                              |
| `pi-builtins`   | [`crates/pi-builtins`](../crates/pi-builtins)     | Every builtin the embedded shell installs: a patched fork of brush's POSIX/bash builtins, plus one module per in-process command-line utility (`cat`, `grep`/`rg`, `sed`, `ls`, `find`, `jq`, `fd`, `diff`, `ps`, `top`, `kill`, the moreutils set, …). `src/host.rs` holds the `Utility` trait and the `Host` view of the shell (stdio, working directory, exported environment, cancellation) that the utilities run against. Ports of uutils coreutils/findutils/sed and jaq live here too; see the crate `LICENSE` for third-party notices. |
| `pi-shell`      | [`crates/pi-shell`](../crates/pi-shell)           | Persistent embedded brush shell, command execution/minimization, process plumbing, filesystem walking, and in-process command integration used by `pi-natives`. |
| `pi-voice`      | [`crates/pi-voice`](../crates/pi-voice)           | Cross-platform microphone/playback and Opus/WebRTC support used by the `AudioCapture`, `AudioPlayback`, and `LiveWebRtcPeer` bindings.                          |
| `pi-ast`        | [`crates/pi-ast`](../crates/pi-ast)               | tree-sitter/ast-grep language registry, matching/editing, block analysis, and summarization support across the workspace grammar set.                           |
| `pi-iso`        | [`crates/pi-iso`](../crates/pi-iso)               | Isolation backend implementations and diffing for APFS, Linux/Windows clone/reflink paths, overlayfs, ProjFS, and recursive copy fallback.                      |
| `pi-walker`     | [`crates/pi-walker`](../crates/pi-walker)         | Parallel, cache-aware filesystem walker using ignore rules and globsets; shared by native grep/glob/workspace paths and shell commands.                         |

## Vendored workspace crates

| Group | Paths | Purpose |
| ----- | ----- | ------- |
| Brush | [`crates/vendor/brush-core`](../crates/vendor/brush-core) | Vendored shell engine consumed by `pi-shell` and `pi-builtins`. Its manifest retains upstream package metadata; a workspace patch selects this local fork. |

`pi_builtins::utility_builtins()` and `pi_builtins::process_builtins()` are the authoritative lists of the commands linked into the embedded shell; `pi-shell` decides which of them to register. A directory being a workspace member does not by itself mean that `pi-natives` exposes it as a JavaScript API.

## Boundary map

```text
@musepi/pi-natives JS entrypoints
  -> pi-natives (N-API conversion, platform bindings, task boundaries)
       -> pi-ast / pi-iso / pi-voice / pi-walker
       -> pi-shell
            -> brush-core (parser, expansion, interpreter)
            -> pi-builtins (bash builtins + utility builtins; host.rs: per-invocation I/O and cwd)
```

For the loader and JS boundary, see:

- [`natives-architecture.md`](./natives-architecture.html)
- [`natives-addon-loader-runtime.md`](./natives-addon-loader-runtime.html)
- [`natives-binding-contract.md`](./natives-binding-contract.html)

Subsystem details live in:

- [`natives-build-release-debugging.md`](./natives-build-release-debugging.html)
- [`natives-media-system-utils.md`](./natives-media-system-utils.html)
- [`natives-rust-task-cancellation.md`](./natives-rust-task-cancellation.html)
- [`natives-shell-pty-process.md`](./natives-shell-pty-process.html)
- [`natives-text-search-pipeline.md`](./natives-text-search-pipeline.html)
- [`fs-scan-cache-architecture.md`](./fs-scan-cache-architecture.html)

## Documentation policy

These crates remain contributor-facing implementation details. Promote one to standalone user-facing documentation only when it gains a public API or executable consumed independently of `@musepi/pi-natives`; see [`user-facing-packages.md`](./user-facing-packages.html).
