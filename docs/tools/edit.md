# edit

> Applies source edits; default mode is the hashline patch language consumed from a single `input` string.

## Source
- Entry: `packages/coding-agent/src/edit/index.ts`
- Model-facing prompt: `packages/hashline/src/prompt.md`
- Key collaborators:
  - `packages/coding-agent/src/utils/edit-mode.ts` — selects active edit mode
  - `packages/hashline/src/grammar.lark` — canonical constrained-decoding grammar
  - `packages/hashline/src/format.ts` — sigils and header constants (`[`, `]`, `#`, `+`, `SWAP`, `CUT`, `INS`, `PASTE`)
  - `packages/hashline/src/input.ts` — parses `[PATH#TAG]` sections
  - `packages/hashline/src/tokenizer.ts` / `packages/hashline/src/parser.ts` — tokenizes and parses ops
  - `packages/hashline/src/apply.ts` — applies parsed edits to file text
  - `packages/hashline/src/mismatch.ts` — stale-anchor mismatch formatting
  - `packages/hashline/src/recovery.ts` — snapshot-based stale-anchor recovery
  - `packages/hashline/src/snapshots.ts` — mints and resolves per-path opaque snapshot tags

## Inputs

### Hashline mode (default)

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `input` | `string` | Yes | One or more file sections. Anchored sections must start with `[PATH#TAG]`; `TAG` is the four-hex snapshot tag emitted by the latest `read`/`grep`/`write`/successful `edit`. Optional `*** Begin Patch` / `*** End Patch` envelope is ignored if present. |

Patch language inside `input`:

- **File header**: `[PATH#TAG]`. `TAG` is four uppercase-hex chars — a content-derived hash of the whole normalized file (`computeFileHash()`), recorded in the session snapshot store.
- **Operations**:
  - `SWAP N.=M:` — replace original lines N.=M with the body rows below.
  - `SWAP.BLK N:` — replace the whole tree-sitter block beginning on line N (its header line through its closing line) with the body rows. The line span is resolved at apply time from the file's parse tree; point N at the line that opens the construct. The resolved span is exactly the node that begins on line N — a leading decorator, attribute, or doc-comment is a separate node and is not included; point N at the first decorator line (Python wraps `@dec` + `def` as one block) or fall back to `SWAP N.=M:` to take a leading line-comment that parses as its own node (e.g. Rust `///`). On success the result echoes the matched span (`SWAP.BLK N → resolved lines A-B`). Errors (and steers to `SWAP N.=M:`) when the language is unsupported, line N is blank or a closing delimiter, no node begins there, or the resolved block has a syntax error.
  - `CUT N.=M` — delete original lines N.=M and capture them in the clipboard. No body. A standalone cut is valid; the latest cut replaces the clipboard contents.
  - `CUT.BLK N` — delete and capture the whole tree-sitter block beginning on line N (resolved like `SWAP.BLK N`, with the same decorator/comment caveat). No body. On success the result echoes the matched span (`CUT.BLK N → resolved lines A-B`). Same resolution failure modes and `CUT N.=M` fallback.
  - `INS.PRE N:` — insert body rows immediately before line N.
  - `INS.POST N:` — insert body rows immediately after line N.
  - `INS.BLK.POST N:` — insert body rows after the last line of the tree-sitter block beginning on line N. Point N at the line that opens the construct, never its closing delimiter / last visible line; if you can see the last line already, use plain `INS.POST M:`. An anchor that can't resolve to a block is lowered to plain `INS.POST N:` with a warning instead of failing the patch.
  - **Markdown sections**: tree-sitter-md nests a heading and its body (including deeper subsections) in one `section` node, so all four block ops anchored on a `#`/`##`/`###` heading line resolve the whole section — heading through every nested deeper heading, up to the next same-or-higher heading. `CUT.BLK` drops and captures the section, `SWAP.BLK` rewrites it, and `INS.BLK.POST` / `PASTE.BLK.POST` land after it. A heading with no body resolves to a single line and is rejected with guidance to use the corresponding plain line op.
  - `INS.HEAD:` — insert body rows at the start of the file.
  - `INS.TAIL:` — insert body rows at the end of the file.
  - `PASTE.PRE N` / `PASTE.POST N` / `PASTE.HEAD` / `PASTE.TAIL` — insert the clipboard at that position. No body. An empty clipboard is an error.
  - `PASTE.BLK.POST N` — insert the clipboard after the resolved block's last line. An unresolvable anchor lowers to `PASTE.POST N` with a warning, matching `INS.BLK.POST`.
  - **Clipboard**: operations execute top-to-bottom across all patch sections. The latest `CUT` wins; `PASTE` does not consume the clipboard and may be repeated. The coding agent persists the register across edit calls in the same session, enabling cross-file moves. Keep each path under one header when clipboard operations would otherwise be interleaved around another file's section.
- **Body rows**:
  - Only body-bearing headers end in `:`.
  - Every body row is `+TEXT`; `+` alone adds a blank line.
  - `CUT` and `PASTE` never have body rows.
  - There is no repeat row kind. To keep a line, leave it out of every range; split edits into multiple hunks when needed.
  - `-` rows are invalid. Literal Markdown bullets or text beginning with `-` / `+` must be written as `+- item` / `++ item`.

Anchors come from `read`/`grep` output. `read` emits a `[PATH#TAG]` header from the session snapshot store and lines as `LINE:TEXT`; copy the header into the edit section and copy only the line number into hunk headers.

### Tolerated input shapes (lenient parsing)

The canonical grammar is strict, but the hand parser accepts a few non-dangerous variants:

- `SWAP N:` — accepted as `SWAP N.=N:`.
- `CUT N` — accepted as a single-line cut/delete.
- Missing trailing colon on `SWAP` or `INS` — accepted.
- `SWAP N-M:`, `SWAP N…M:`, `SWAP N M:`, and legacy `SWAP N..M:` — accepted as `SWAP N.=M:`.
- Bare body rows with no `+` prefix are auto-prepended with `+` and a `BARE_BODY_AUTO_PIPED_WARNING` is appended.
- Bare `-` body rows are judged once the whole hunk body is known: when every `-` row is Markdown-bullet-shaped (`- item`) and the body is either fully bare or contains an explicit `+- item` sibling, the rows are kept as literal content and `MINUS_BULLET_AUTO_PIPED_WARNING` is appended; otherwise they are rejected as unified-diff contamination (see Errors).
- `*** Begin Patch` / `*** End Patch` envelopes are silently consumed. `*** Abort` terminates parsing silently — ops parsed before the marker still apply, no warning surfaced.
- Some malformed bracketed headers are recovered after stripping apply-patch path noise such as `Update File:` / `Add File:` and extra `***`, but the recovered header still needs a valid four-hex tag for the patcher to apply it.
- `*** Update File:` / `*** Add File:` / `*** Delete File:` / `*** Move to:` apply_patch sentinels inside the diff body throw an `apply_patch sentinel … is not valid in hashline` error.
- `@@`-bracketed hunk headers are rejected with guidance to write a verb header.
- Bare `N` and bare `N M` / `N.=M` headers are rejected with guidance to write `SWAP` or `CUT`.
- A trailing colon on `CUT N.=M:` / `CUT.BLK N:` is tolerated and ignored, but body rows under `CUT`, `CUT.BLK`, or any `PASTE` form are rejected.
- Bare `PASTE` is rejected because the insertion position is required.
- Empty `INS` / `SWAP.BLK` hunks are rejected; an empty `SWAP N.=M:` deletes the range, though `CUT N.=M` is the canonical deletion form.
- `-` body rows are rejected with `MINUS_ROW_REJECTED` unless the hunk is unambiguously a Markdown bullet list (see Tolerated input shapes).
- `SWAP.BLK N:` / `CUT.BLK N` / `INS.BLK.POST N:` / `PASTE.BLK.POST N` consult the wired tree-sitter resolver. `SWAP.BLK` and `INS.BLK.POST` need at least one `+TEXT` body row; `CUT.BLK` and `PASTE.BLK.POST` take none. A null resolution rejects `SWAP.BLK` / `CUT.BLK` on the apply or final-preview path (the streaming preview silently drops it), while `INS.BLK.POST` / `PASTE.BLK.POST` lower to the corresponding plain `POST` form with a warning. A single-line resolution rejects every block form with guidance to use its plain line equivalent.

## Outputs
- Single-shot tool result; hashline mode does not use the staged preview/apply devices (`/xdev/resolve`, `/xdev/reject`).
- `content` contains one text block per call. For a successful single-file edit it is the post-edit `[path#TAG]` section header (a fresh snapshot tag for the written content), followed by a compact diff preview from `packages/hashline/src/diff-preview.ts` when one is emitted.
- When the patch used `SWAP.BLK` / `CUT.BLK` / `INS.BLK.POST` / `PASTE.BLK.POST` ops (and the apply matched the tagged content), one `<OP> N → resolved lines A-B (K lines)` line per block op is inserted between the `[PATH#TAG]` header and the diff preview. Single-line spans render `resolved line A (1 line)`; `INS.BLK.POST` appends `body lands after line B`, and `PASTE.BLK.POST` appends `clipboard lands after line B`.
- Parse, apply, or recovery warnings are appended as:

```text
Warnings:
...
```

- `details` is `EditToolDetails` from `packages/coding-agent/src/edit/renderer.ts`:
  - `diff`: unified diff string
  - `firstChangedLine`: first changed post-edit line
  - `diagnostics`: LSP/format result if available
  - `op`: `"create"` or `"update"` for hashline mode
  - `meta`: output metadata
  - `perFileResults`: present for multi-section input
- Multi-section input returns one aggregated result with combined text and per-file details.

## Worked examples

Reference file (the exact shape `read` returns):

```text
[a.ts#0A3B]
1:const X = "a";
2:const Y = X;
3:
4:console.log(X);
5:console.log(Y);
6:export { X, Y };
```

Replace line 1 with two lines:

```text
[a.ts#0A3B]
SWAP 1.=1:
+const X = "b";
+export const Y = X;
```

Insert below line 5:

```text
[a.ts#0A3B]
INS.POST 5:
+console.log(X + Y);
```

Insert above line 5:

```text
[a.ts#0A3B]
INS.PRE 5:
+console.log(X + Y);
```

Delete lines 4.=5 entirely and leave them in the clipboard:

```text
[a.ts#0A3B]
CUT 4.=5
```

Insert at start and end of file:

```text
[a.ts#0A3B]
INS.HEAD:
+// header
INS.TAIL:
+// trailer
```

Move line 4 from `src/a.ts` to after line 20 in `src/b.ts`:
```text
[src/a.ts#0A3B]
CUT 4
[src/b.ts#1F7C]
PASTE.POST 20
```

## Limits & Caps
- File snapshot tags are exactly four uppercase-hex chars — content-derived hashes (`computeFileHash()`) recorded in the per-session snapshot store.
- The visible mismatch report shows 2 lines of context on each side (`MISMATCH_CONTEXT`) in `packages/hashline/src/messages.ts`.
- Stale-anchor recovery uses `fuzzFactor: 0` in `packages/hashline/src/recovery.ts`.
- `HL_FILE_PREFIX` is `[`, `HL_FILE_SUFFIX` is `]`, `HL_PAYLOAD_REPLACE` is `+`, `HL_RANGE_SEP` is `.=`, `HL_FILE_HASH_SEP` is `#`, and line/clipboard hunk keyword constants are `SWAP` / `CUT` / `INS` / `PASTE` (`packages/hashline/src/format.ts`).

## Errors
- Missing section header:
  - `input must begin with "[PATH#HASH]" on the first non-blank line for anchored edits; got: ...`
- Missing tag for any section:
  - `Missing hashline snapshot tag for <path>; use \`[<path>#tag]\` from your latest read/search output. To create a new file, use the write tool.`
- Stray payload line:
  - `line N: payload line has no preceding hunk header. Use \`SWAP N.=M:\`, \`CUT N.=M\`, or \`INS.PRE|POST|HEAD|TAIL:\` above the body. Got "...".`
- Minus row (unless auto-piped as an unambiguous Markdown bullet — see Tolerated input shapes):
  - ``line N: `-` rows are not valid; the range already names the lines being changed. For Markdown bullets or other literal `-` lines, prefix the literal row with `+`: `+- item`.``
- Empty body-bearing hunk:
  - `line N: \`INS\` needs at least one \`+TEXT\` body row.`
  - `line N: \`SWAP.BLK N:\` needs at least one \`+TEXT\` body row. To delete a block, use \`CUT.BLK N\`.`
- Unresolvable block anchor — `SWAP.BLK` / `CUT.BLK` only (apply / final-preview path; the streaming preview silently drops the op instead):
  - `line N: \`SWAP.BLK X:\` could not resolve a syntactic block beginning on line X (unsupported language, blank/closer line, or parse error). Use \`SWAP X.=M:\` with explicit lines.` — followed by numbered context and, when available, a nearby block suggestion. `CUT.BLK X` produces the corresponding message with a `CUT X.=M` fallback.
  - `INS.BLK.POST X:` and `PASTE.BLK.POST X` never reach this error when no block resolves — they lower to plain `INS.POST X:` / `PASTE.POST X` with a warning.
- Clipboard operation errors:
  - `line N: \`CUT N.=M\` captures + deletes lines and takes no body rows. To replace lines with new content, use \`SWAP N.=M:\`.`
  - `line N: \`PASTE\` inserts the clipboard content and takes no \`+\` body rows. To insert literal text, use \`INS\`.`
  - `line N: \`PASTE\` found nothing in the clipboard. Ops run top-to-bottom across the whole patch (sections included): put \`CUT N.=M\` or \`CUT.BLK N\` above the \`PASTE\`.`
- Range out of order:
  - `line N: range A.=B ends before it starts.`
- Overlapping hunks on the same anchor:
  - `line N: anchor line X is already targeted by another hunk on line Y. Issue ONE hunk per range; payload is only the final desired content, never a before/after pair.`
- apply_patch / unified-diff contamination:
  - `line N: apply_patch sentinel "*** …" is not valid in hashline. File sections start with \`[path#HASH]\` (no \`Update File:\` / \`Add File:\` keyword). Use \`SWAP N.=M:\`, \`CUT N.=M\`, or \`INS.PRE|POST|HEAD|TAIL:\` ops.`
  - `line N: unified-diff hunk header (\`@@ -N,M +N,M @@\`) is not valid in hashline. Use \`SWAP N.=M:\`, \`CUT N.=M\`, or \`INS.PRE|POST|HEAD|TAIL:\` ops.`
  - `line N: \`@@\`-bracketed hunk header "@@ …" is not valid in hashline. Drop the \`@@ ... @@\` brackets and write a verb header such as \`SWAP N.=M:\`.`
  - `line N: hunk headers need a verb. Use \`SWAP N.=N:\` to replace, or \`CUT N\` to delete.`
  - `line N: bare range hunk header "N M" is not valid. Hunk headers need a verb: write \`SWAP ${bareRange[1]}.=${bareRange[2]}:\` or \`CUT ${bareRange[1]}.=${bareRange[2]}\`.`
- Out-of-range anchor:
  - `Line N does not exist (file has M lines)`
- Stale snapshot tag: the `Patcher` first attempts snapshot-based recovery. When recovery cannot prove a valid result it throws `MismatchError`, which distinguishes recognized-but-drifted hashes from never-recorded hashes. The error includes the current file hash plus context around each anchor.
- No-op edit:
  - `Edits to <path> parsed and applied cleanly, but produced no change: your body row(s) are byte-identical to the file at the targeted lines. The bug is somewhere else — re-read the file before issuing another edit. Do NOT widen the payload or add lines; verify the anchor first.`
  - After `NOOP_HARD_LIMIT = 3` consecutive byte-identical no-ops of the same payload on the same file, the soft text result escalates to a `ToolError` (`STOP. Edits to <path> have been a byte-identical no-op N times in a row …`) from `packages/coding-agent/src/edit/hashline/noop-loop-guard.ts`.
- Recovery failure is silent internally: if cache-based merge cannot prove a valid result, the mismatch error is surfaced unchanged.

## Warnings
- `Auto-prefixed bare body row(s) with +. Body rows must be +TEXT literal lines …` (`BARE_BODY_AUTO_PIPED_WARNING`)
- `Auto-prefixed bare `- ` bullet row(s) as literal content …` (`MINUS_BULLET_AUTO_PIPED_WARNING`)
- Recovery banners: `RECOVERY_EXTERNAL_WARNING`, `RECOVERY_SESSION_CHAIN_WARNING`, `RECOVERY_SESSION_REPLAY_WARNING` (`packages/hashline/src/messages.ts`).
