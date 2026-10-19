# plugins/ — how this directory is organised

One flat directory held 51 modules with no visible grouping: the mount pipeline
sat next to the marketplace installer, next to parsers for a foreign patch
format. The grouping below is by **what a module is responsible for**, and the
rule for adding one is: put it in the group that would have to change if its
responsibility changed.

| Directory | Responsibility |
|---|---|
| `runtime/` | Loading and mounting a plugin: the entry shapes, the cordis primitives a plugin gets, the mount pipeline, the session-level loader, the plugin type vocabulary. |
| `hmr/` | Deciding that a loaded plugin's source changed on disk (one implementation, both plugin tracks). |
| `management/` | Installing, listing, enabling, removing and diagnosing plugins: the installer, the package manager, the marketplace auto-update, the install state machine, build approval, the doctor and capability report. |
| `profile/` | Composing a profile out of layers: profile composition, patch editing, the runtime config lock, manifest blocks, registry config and fallback. |
| `dsh/` | The **DSH file-format contract**: reading a `cordis.patch.yml`, folding its layer stack, `!!js` expression handling, bundle declarations, name resolution. |
| `compat/` | The legacy Pi extension compatibility layer: the module loader shims, the virtual-module declarations, the plugin compatibility gate and its exemption store. |
| `shared/` | Modules with no plugin-specific meaning: the feature-bracket specifier parser, git URL parsing, the git-backed package cache, the exclusive-mount declaration. |
| `marketplace/` | The marketplace catalog: fetching, caching, registry and entry listing. |

`index.ts` is the barrel and re-exports the public surface.

## On the `dsh/` naming

Those modules are **not copied from DSH**. They read and translate DSH's
on-disk formats — a patch file, a bundle manifest, a package name — and the
`dsh-` prefix is there so the name states which foreign format it handles. A
module that merely happened to be filed alongside them but has no DSH meaning
belongs in `shared/`, which is why the specifier parser and the git helpers moved
out.

The modules carry line references into the DSH sources they mirror
(`deepseek-harness/packages/boot/app-boot/src/profile-context.ts:63-74` and
similar). Those references are the maintenance contract: when DSH changes the
format, the reference is how to find what changed. They are not a copy of the
implementation, and nothing here is generated from DSH.
