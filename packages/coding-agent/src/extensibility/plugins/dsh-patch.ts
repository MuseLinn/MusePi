/**
 * Read a DSH `cordis.patch.yml` without running any of it.
 *
 * A DSH patch file marks values it wants evaluated at load time with the YAML
 * tag `!!js`, and the Loader turns those into a `with (ctx) { eval(expr) }`
 * over its own context. This host does not do that and will not: a bundle is a
 * package this host installed, and a value it cannot translate must be reported
 * rather than evaluated, because evaluating is how a package that was merely
 * installed ends up running code it was never given.
 *
 * What this does instead is keep the two kinds of value apart. Bun's parser
 * drops an unknown tag and hands back the bare scalar, which would make
 * `disabled: !!js process.platform === 'win32'` indistinguishable from
 * `disabled: process.platform === 'win32'` written as a literal string. So the
 * tag is rewritten to a marker before parsing and recovered after it, and every
 * marked value comes back tagged. What the caller can then do with a tag is its
 * own decision, and `config` values — which are usually an expression whose
 * result only DSH could produce — can be refused without also refusing the row
 * they belong to.
 *
 * Only the `insert` form is read. DSH's other patch forms address rows by id to
 * override or disable them, and resolving those needs the full layer stack this
 * host does not have; accepting them would mean guessing which row they meant.
 *
 * @module extensibility/plugins/dsh-patch
 */

import { YAML } from "bun";

/**
 * Stand-in for the `!!js` tag.
 *
 * A token no YAML scalar in a patch file contains, so finding one afterwards
 * identifies exactly the values the tag was on. The NUL-free form matters:
 * YAML rejects a null character inside an unquoted scalar.
 */
const JS_EXPR_MARKER = "__MUSEPY_DSH_JS_EXPR__";

/** A value the `!!js` tag was on, with the expression it carried. */
export interface DshJsExpr {
	readonly kind: "js-expr";
	readonly expr: string;
}

/** An ordinary literal from the file. */
export type DshValue = string | number | boolean | null | DshValue[] | { [key: string]: DshValue } | DshJsExpr;

/** One row a patch file inserts into the Loader tree. */
export interface DshPatchRow {
	/** The row's id, which later layers patch by. */
	readonly id: string;
	/** The npm package the row names. */
	readonly name: string;
	/**
	 * Whether the row is disabled, when the file says so.
	 *
	 * `undefined` when the file says nothing, which is not the same as `false`:
	 * the Loader treats an absent `disabled` as enabled, and so does this.
	 */
	readonly disabled: DshValue | undefined;
	/** The row's configuration, when it carries one. */
	readonly config: DshValue | undefined;
	/** Service names the row injects. */
	readonly inject: readonly string[];
	/** Whether the row is a group of other rows. */
	readonly group: boolean;
}

/** The rows one patch file inserts, and what could not be read. */
export interface DshPatchDocument {
	readonly rows: readonly DshPatchRow[];
	/**
	 * Entries skipped because they were not a readable insert.
	 *
	 * `droppedExpressions` is how many `!!js` values the skipped entry carried —
	 * data discarded with the entry rather than translated, reported so that a
	 * caller listing what was not taken says what was lost with it.
	 */
	readonly skipped: readonly {
		readonly index: number;
		readonly reason: string;
		readonly droppedExpressions: number;
	}[];
}

/**
 * Rewrite the `!!js` tag to a marker so parsing preserves it.
 *
 * Bun's parser strips the tag and hands back the bare scalar, which makes a
 * tagged value indistinguishable from the same text written literally — the two
 * differ only by a prefix the parser threw away. So the tag is marked before
 * parsing and recovered after it.
 *
 * The marker and the expression it introduces have to end up inside one quoted
 * scalar. Leaving the expression's own quotes in place makes the line invalid:
 * once `!!js` is gone, `key: MARKER "expr"` is a bare scalar with trailing
 * content, which YAML rejects in a mapping value. The expression's own quotes are
 * therefore consumed here and re-escaped into a single quoted scalar, so what
 * the parser sees is a plain string.
 *
 * Two places are left alone. Inside a block scalar a tag-looking token is
 * content, not a tag: a plugin description telling a model to write `!!js` must
 * survive as that text. And a line whose `!!js` carries nothing after it is
 * marked as-is, because there is no expression to fold into a scalar.
 */
function markJsExpressions(source: string): string {
	const out: string[] = [];
	let blockIndent = -1;
	for (const line of source.split("\n")) {
		const indent = line.length - line.trimStart().length;
		if (blockIndent >= 0) {
			if (indent > blockIndent && line.trim() !== "") {
				out.push(line);
				continue;
			}
			blockIndent = -1;
		}
		if (/:\s*[|>][-+]?\s*$/.test(line)) {
			blockIndent = indent;
			out.push(line);
			continue;
		}
		out.push(foldTagIntoQuotedScalar(line));
	}
	return out.join("\n");
}

/**
 * Fold `!!js <expression>` on one line into a single quoted scalar carrying the
 * marker, so the expression survives parsing intact and unevaluated.
 */
function foldTagIntoQuotedScalar(line: string): string {
	return line.replace(/!!js\s+(.+?)\s*$/, (_match, expr: string) => {
		const quoted = expr.startsWith('"') && expr.endsWith('"') && expr.length > 1;
		const body = quoted ? expr.slice(1, -1) : expr;
		const escaped = body.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
		return `"${JS_EXPR_MARKER} ${escaped}"`;
	});
}

/**
 * Recover marked scalars as expressions, recursively.
 *
 * Runs after parsing so the marker survives as data rather than having to be
 * recognised in raw text.
 */
function revive(value: unknown): DshValue {
	if (typeof value === "string") {
		return value.startsWith(JS_EXPR_MARKER)
			? { kind: "js-expr", expr: value.slice(JS_EXPR_MARKER.length).trim() }
			: value;
	}
	if (Array.isArray(value)) return value.map(revive);
	if (value !== null && typeof value === "object") {
		const out: Record<string, DshValue> = {};
		for (const [key, entry] of Object.entries(value)) out[key] = revive(entry);
		return out;
	}
	return value as DshValue;
}

/**
 * Count the tagged expressions inside a value.
 *
 * A skipped entry's expressions are dropped with it, and dropping them silently
 * means a file whose non-insert half carried all of its dynamic configuration
 * parses "cleanly" while half of what it said was lost. The count is what turns
 * that from a silent omission into a number the caller can report.
 */
function countTagged(value: unknown): number {
	if (value === null || value === undefined) return 0;
	if (typeof value === "object" && (value as { kind?: string }).kind === "js-expr") return 1;
	if (Array.isArray(value)) return value.reduce((sum, item) => sum + countTagged(item), 0);
	if (typeof value === "object") return Object.values(value).reduce((sum, item) => sum + countTagged(item), 0);
	return 0;
}

/**
 * Parse a DSH patch file into the rows it inserts.
 *
 * @param source - the file's contents.
 * @returns the readable rows, and a note for every entry that was not one —
 * including how many `!!js` expressions the skipped entry carried, since those
 * are dropped with it and a caller that reports only "skipped" would be hiding
 * the interesting part.
 * @throws {Error} when the file is not parseable at all, which is a corrupt file
 * rather than a shape this reader does not handle.
 */
export function parseDshPatch(source: string): DshPatchDocument {
	const parsed = YAML.parse(markJsExpressions(source)) as unknown;
	if (parsed === null || parsed === undefined) return { rows: [], skipped: [] };
	if (!Array.isArray(parsed)) {
		throw new Error(`a DSH patch file is a list of patch entries, got ${typeof parsed}`);
	}

	const rows: DshPatchRow[] = [];
	const skipped: { index: number; reason: string; droppedExpressions: number }[] = [];
	parsed.forEach((entry: unknown, index: number) => {
		if (entry === null || typeof entry !== "object") {
			skipped.push({ index, reason: "not a patch entry object", droppedExpressions: 0 });
			return;
		}
		const record = entry as Record<string, unknown>;
		const insert = record.insert;
		if (!Array.isArray(insert)) {
			// Every other form DSH supports targets rows by id, which needs the
			// layer stack this host does not build. Its tagged expressions are
			// dropped with it, so the count travels with the skip.
			skipped.push({
				index,
				reason: record.id === undefined ? "no insert list and no id to target" : "id-targeted patch",
				droppedExpressions: countTagged(revive(record)),
			});
			return;
		}
		for (const raw of insert as unknown[]) {
			if (raw === null || typeof raw !== "object") {
				skipped.push({ index, reason: "insert entry is not an object", droppedExpressions: 0 });
				continue;
			}
			const row = raw as Record<string, unknown>;
			const id = typeof row.id === "string" ? row.id : undefined;
			const name = typeof row.name === "string" ? row.name : undefined;
			if (id === undefined || name === undefined) {
				skipped.push({
					index,
					reason: "insert entry is missing id or name",
					droppedExpressions: countTagged(revive(raw)),
				});
				continue;
			}
			rows.push({
				id,
				name,
				disabled: row.disabled === undefined ? undefined : revive(row.disabled),
				config: row.config === undefined ? undefined : revive(row.config),
				inject: Array.isArray(row.inject)
					? (row.inject as unknown[]).filter((n): n is string => typeof n === "string")
					: [],
				group: row.group === true,
			});
		}
	});

	return { rows, skipped };
}
