# Cleanup Command

One iteration of an autonomous cleanup loop. Each run: discover ONE target, execute it completely, verify, report. Runs are stateless — derive everything from the current tree; assume prior iterations already happened and left the tree consistent.

<critical>
- Behavior-preserving ONLY. Observable behavior of the CLI, SDK, RPC surface, and rendered output NEVER changes.
- Every iteration MUST deliver a named, concrete quality win (duplicate implementation gone, responsibility extracted, dead cluster removed, guard clutter deleted). Lean toward deletion: net-negative LOC is the expected shape and the tie-breaker between candidates, but justified net-neutral/positive work (a split, a hierarchy fix) is acceptable when the win is real. Report the LOC delta either way.
- NEVER commit. NEVER touch generated or vendored code.
- Complete the full cutover in this run: every copy migrated, every callsite updated, originals deleted. Half-migrations are worse than nothing.
- No target clears the bar? Output exactly `CLEAN: no target above threshold` and stop.
</critical>

## Scope

- TypeScript only. Priority order: `packages/coding-agent`, `packages/ai`, `packages/catalog`, `packages/utils`. Other packages MAY be edited only when callsite migration drags them in.
- NEVER touch: `**/*-gen/**`, `**/vendor/**`, generated JSON catalogs, `.d.ts`, test fixtures/snapshots, lockfiles, anything non-TS.

## 1. Discover

Run the scanner first: `bun scripts/cleanup-scan.ts` (add `--json` for machine output, `--pkg=<a,b>|all` to widen). It reports god-object candidates, clone clusters with line ranges, junk drawers, tiered dead-export candidates, deep relative imports, and defensive-check hotspots. Scanner output is EVIDENCE, not verdict — every entry still needs reading before action. Supplement with `lsp references` and targeted grep where the scanner is blind (semantic duplication, wrong-home modules with shallow imports).

Candidate classes:

**Dead weight** (highest value per risk)
- Exported symbols with zero non-test references in the repo (scanner: `dead-exports`). Tiers: `barrel-public` (re-exported through an explicit `exports`-map entry or public barrel) = published surface, PROTECTED — external consumers exist that no tool can see. `wildcard-only` (importable only via a `./*` subpath pattern) = internal-by-default, deletable once proven.
- Options/parameters no caller passes; branches no input reaches.
- Compatibility shims, deprecated aliases, re-export indirection left by past refactors.
- Runtime checks re-verifying what the type system already guarantees.

**Duplication**
- Scanner `clones` clusters give exact line ranges; literal-heavy boilerplate (schema tables, registry descriptors) is repetitive by design — extract only when a helper genuinely simplifies every site.
- Same helper reimplemented in 2+ files; copies differing only by a literal or flag.
- Inline reimplementations of an existing central utility (path shortening, truncation, spawning, stream reading, caching).
- Parallel switch/if-chains that dispatch on the same discriminant in multiple places.

**God objects**
- Files whose size dwarfs their siblings AND mix responsibilities (state + IO + rendering + parsing in one module; classes whose method list spans several domains).
- Size alone is not a smell — a large file with one coherent responsibility stays.

**Hierarchy rot**
- Junk drawers: modules named after no domain (`utils`, `helpers`, `misc`, `common`) accreting unrelated code.
- Deep relative imports (`../../..`) signaling a module living in the wrong place.
- Directories grouped by kind (`types/`, `constants/`, `interfaces/`) instead of domain.
- Barrels re-exporting things nobody imports through them; single-file directories; module names that no longer describe contents.

## 2. Select

Score candidates by `(quality win × confidence) / blast radius`. Pick exactly ONE cluster, roughly ≤12 files touched. Tie-break: deletion > dedup > split > move; between equals, prefer the larger LOC reduction.

Bar for "worth doing" — a quality win you can name in one sentence, e.g.:
- Removes an entire duplicate implementation or ≥100 duplicated/dead lines.
- Splits a file that is both oversized for its package and multi-responsibility.
- Eliminates a junk drawer, dead-export cluster, or guard-clutter hotspot entirely.
- Moves a module cluster so the tree reads as designed, not accreted.

## 3. Execute

**Dead weight / type checks**
- Delete dead exports and the tests that only mirrored them. Two proofs REQUIRED before deleting any export: (1) `lsp references` shows no callsites — missed callsites are bugs; (2) the symbol is `wildcard-only`: not re-exported, directly or transitively, through any explicit `exports`-map entry or public barrel. Fails either proof? It stays.
- Narrow once at the IO boundary; internal code takes the narrowed type. Delete downstream `?.` chains on non-nullable values, `?? fallback` on non-optional, `typeof`/`Array.isArray` re-narrowing, `as` casts papering over flow.
- Value genuinely sometimes-absent? Fix the TYPE upstream; NEVER sprinkle guards downstream.
- try/catch that swallows and limps on → delete it or let the error propagate. Precise catches (e.g. ENOENT) only.

**Dedup**
- 2+ copies → one function in the nearest common domain module; cross-package → the shared utils package. NEVER create a new junk drawer to hold it.
- Copies differing by a literal/flag → one function with an options object. NEVER boolean positionals.
- Prefer the hardened copy (timeouts, caps, sanitization) as the survivor; the fresh copies lose that hardening.

**God objects**
- Split along existing seams into domain-named modules; one responsibility each.
- Extraction is MOVEMENT: code moves verbatim except imports/visibility. Rewriting-while-moving hides regressions.
- Update every importer; NEVER leave a re-export shim. A split that introduces an interface, base class, event bus, or DI where a direct call existed is a failed split.

**Hierarchy**
- Move files with `lsp rename_file` so imports rewrite everywhere.
- Group by domain, not kind. Collapse single-file directories; delete empty barrels.
- After the move, the tree MUST read as if this were always the design.

**Perf** (opportunistic — only inside code already being touched)
- Hoist loop invariants; precompile regexes; single pass over chained filter/map on hot paths; drop intermediate arrays/strings/copies.
- NEVER trade clarity for micro-perf on cold paths. NEVER add caching layers.

## 4. Prohibitions

- NEVER add: dependencies, config/options, feature flags, wrapper layers, abstractions with one implementation, "future-proofing".
- NEVER rename or alter public surface. Public surface = the CLI, plus every symbol reachable from an explicit (non-wildcard) `exports`-map entry point or public barrel — external consumers exist beyond this repo's references. Wildcard `./*` subpaths expose files mechanically, not contractually; explicit entries and barrels are the contract.
- NEVER reformat or restyle code outside the touched cluster.
- NEVER do drive-by comment/doc sweeps; comment only new non-obvious code.
- NEVER add tests for moved-but-unchanged code; keep existing tests passing, relocating them alongside their subject.

## 5. Verify

1. `bun check` — clean.
2. Run the touched package's tests scoped to affected areas.
3. Renderer/TUI code touched? Confirm sanitization helpers still wrap every render path.

## 6. Report

- Target: what was chosen and which smell class.
- Actions: deleted / merged / split / moved, the named quality win, and the LOC delta.
- Verification: exact commands run and results.
- Risk: anything a reviewer should eyeball.

<critical>
- One target per run, executed to completion — full callsite migration, originals deleted, `bun check` clean.
- A named quality win, behavior identical, no new abstractions, no shims. Deletion-leaning: justify any net-positive delta.
- Nothing above the bar → output `CLEAN: no target above threshold`.
</critical>
