# MusePi Assembly — Declarative Assembly and Boot Verification

[English](assembly.md) | [中文](assembly.zh-CN.md)

`musepi.assembly.toml` is the musepi product assembly manifest. It declares:
- **surface** (TUI / daemon / headless) — controls which extensions are loaded
- **managed extensions** — declared extensions fail **fail-loud** by default, avoiding silent fallback
- **seams** — explicitly selectable swappable core implementations (terminal provider, compaction method)

## File location and discovery order

Project-level > Global-level (project wins per key):

1. `<cwd>/.musepi/assembly.toml` (discovered from cwd upward)
2. `$MUSEPI_AGENT_DIR/assembly.toml` (agent directory of the current profile)
3. `~/.musepi/assembly.toml` (user global)

## Format

```toml
[assembly]
# surface = "tui" | "daemon" | "headless" | "acp"   # default auto (by mode)
degraded_ok = false                                  # extension load failure semantics

[extensions]
# include = ["my-extension", "another-ext"]          # whitelist
# exclude = ["*debug*", "*legacy*"]                  # exclusion glob
# patterns = ["**/tools/**", "extensions/skills"]    # path filtering

[seams.terminal]
provider = "auto"        # "auto" | "bun-pty" | "node-pty"

[seams.compaction]
method = "snapcompact"   # preferred compaction method
```

## Behavior

### Boot verification
- **No manifest** → preserve existing behavior (all errors warn, session continues)
- **Manifest present** → managed extension load errors **throw** (unless `degraded_ok = true`)
- unmanaged extension errors still warn, visible via `musepi assembly status`

### Surface filtering
- `musepi assembly verify` reads the current cwd manifest and prints the filtered extension count
- `extensions.patterns` in the manifest controls the extension load glob

### Seam selection
- `terminal.provider` controls the daemon terminal backend: `auto` (default) = fall back to node-pty when bun-pty fails; explicit value = error on failure
- `compaction.method` is only manifest-side validation — actual compaction is controlled by `settings.compaction.methodOrder`

## CLI commands

```bash
musepi assembly status      # show current manifest, surface, and boot status
musepi assembly verify      # statically verify manifest + extension path filtering results
```

## Design principles

1. **Progressive enablement**: without manifest, legacy behavior stays the same; upgrades are seamless for existing users
2. **fail-loud on declared**: declared managed extensions fail loudly; undeclared ones continue soft-fail
3. **Visibility**: all failures are visible through `musepi assembly status`, never silent
4. **Config-driven**: the manifest is the single source of configuration, settings are read-only (`terminal.provider` can still be explicitly overridden via settings)
