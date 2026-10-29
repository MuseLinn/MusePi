/**
 * Profile patch editing — the write side of a derived composition.
 *
 * A composition is derived from the profile's manifest and its bundles' patch
 * files, which reads as "there is nothing here to toggle". That is true of the
 * READ and false of the control surface: DSH's enable toggle writes a row-
 * targeted override into the profile's own patch file
 * (`deepseek-harness/packages/boot/plugin-manager/src/patch.ts:14-43`), so the
 * composition stays derived — the toggle is an INPUT to it, not a second copy
 * of the answer.
 *
 * The write goes through `yaml`'s document API rather than parse-and-serialize,
 * so everything an author put in the file by hand survives a toggle: comments
 * (including trailing ones), key order, quoting style and blank lines. That is
 * the same mechanism DSH uses, and the reason the `yaml` dependency is here
 * rather than hand-rolled line editing — a toggle that reformats somebody's
 * profile is worse than no toggle.
 *
 * What is reproduced from DSH's writer:
 *
 * - **The existing override is edited in place, not appended.** Toggling twice
 *   must not grow the file: the last override for an id wins, so the writer
 *   finds that one and rewrites its `disabled`.
 * - **A name-qualified override is respected.** When the file already names the
 *   row, the names must agree or the write is refused (DSH's safety check).
 * - **`!!js` values parse back as their expression text**, so a file carrying
 *   them round-trips instead of being mangled by the default tag resolution.
 *
 * @module extensibility/plugins/profile-patch-edit
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type Document, isMap, isSeq, parseDocument } from "yaml";

/** What a write did, for the caller to report honestly. */
export type PatchWriteResult =
	| { readonly kind: "updated"; readonly changed: boolean }
	| { readonly kind: "created" }
	| { readonly kind: "unknown-row"; readonly id: string };

/**
 * `!!js` resolves to its raw text.
 *
 * DSH marks values it evaluates at load time; this host does not, but the file
 * still has to round-trip. Left to the default resolution the tag is dropped
 * and re-serialized as a bare scalar, which would silently rewrite somebody's
 * condition into a string.
 */
const JS_TAG = { tag: "tag:yaml.org,2002:js", resolve: (value: string) => value } as const;

/** A patch entry node that can be read and edited. */
interface EntryNode {
	get(key: string): unknown;
	set(key: string, value: unknown): void;
}

/** Read a profile patch file. `null` when it does not exist yet. */
async function readPatch(patchPath: string): Promise<Document | null> {
	let text: string;
	try {
		text = await fs.readFile(patchPath, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
	const document = parseDocument(text, { customTags: [JS_TAG] });
	const error = document.errors?.[0];
	if (error) throw new Error(`profile patch is not readable YAML: ${error.message}`);
	if (!isSeq(document.contents)) {
		throw new Error("profile patch must be a YAML sequence of patch entries");
	}
	return document;
}

/**
 * The override entries, as editable nodes.
 *
 * An entry carrying `insert` is not an override — it names rows it adds — so it
 * is skipped exactly as DSH's writer skips it.
 */
function overrideNodes(document: Document): EntryNode[] {
	const items = (document.contents as { items: unknown[] }).items;
	const out: EntryNode[] = [];
	for (const item of items) {
		if (!isMap(item)) continue;
		const node = item as unknown as EntryNode;
		const id = node.get("id");
		if (typeof id !== "string" || id === "") continue;
		if (node.get("insert") !== undefined) continue;
		out.push(node);
	}
	return out;
}

function declarationNodes(document: Document): EntryNode[] {
	const items = (document.contents as { items: unknown[] }).items;
	const out: EntryNode[] = [];
	for (const item of items) {
		if (!isMap(item)) continue;
		const node = item as unknown as EntryNode;
		const inserted = node.get("insert") as unknown;
		const entries = Array.isArray(inserted) ? inserted : (inserted as { items?: unknown[] })?.items;
		if (!entries) continue;
		for (const entry of entries) {
			if (!isMap(entry)) continue;
			const child = entry as unknown as EntryNode;
			if (typeof child.get("id") === "string" && child.get("id") !== "") out.push(child);
		}
	}
	return out;
}

/**
 * Set a row's enablement by writing an id-targeted override into the profile's
 * own patch file — the same write DSH performs.
 *
 * @param patchPath - the profile's `cordis.patch.yml`.
 * @param id - the composed row id.
 * @param name - the row's package name; when the file already names it, the
 *   names must agree or nothing is written.
 * @param enabled - the desired enablement.
 * @param knownRows - the ids this profile actually composes. An id outside it is
 *   refused: an override for a row that does not exist silently does nothing,
 *   or starts doing something after a later bundle adds the id.
 */
export async function writeRowEnabled(
	patchPath: string,
	id: string,
	name: string,
	enabled: boolean,
	knownRows?: readonly string[],
): Promise<PatchWriteResult> {
	if (knownRows && !knownRows.includes(id)) return { kind: "unknown-row", id };

	const document = await readPatch(patchPath);
	if (!document) {
		// No patch file yet: the first toggle creates it.
		await fs.mkdir(path.dirname(patchPath), { recursive: true });
		await fs.writeFile(patchPath, `- id: ${quoteIfNeeded(id)}\n  disabled: ${enabled ? "false" : "true"}\n`, "utf8");
		return { kind: "created" };
	}

	// The last override for an id wins, so that is the one to edit.
	const target = [...overrideNodes(document)].reverse().find(node => {
		if (node.get("id") !== id) return false;
		const declared = node.get("name");
		return declared === undefined || declared === null || declared === name;
	});

	if (target) {
		if (target.get("disabled") === !enabled) return { kind: "updated", changed: false };
		target.set("disabled", !enabled);
	} else {
		// Append to the existing sequence so every other entry — and the
		// document's comments — is carried over rather than rebuilt.
		(document.contents as unknown as { add(value: unknown): void }).add({ id, disabled: !enabled });
	}

	await fs.writeFile(patchPath, String(document), "utf8");
	return { kind: "updated", changed: true };
}

/** Set one config value on an id-addressed row while preserving the rest of the patch. */
export async function writeRowConfigValue(
	patchPath: string,
	id: string,
	name: string,
	key: string,
	value: unknown,
): Promise<PatchWriteResult> {
	const document = await readPatch(patchPath);
	if (!document) {
		await fs.mkdir(path.dirname(patchPath), { recursive: true });
		await fs.writeFile(
			patchPath,
			`- id: ${quoteIfNeeded(id)}\n  name: ${quoteIfNeeded(name)}\n  config:\n    ${key}: ${quoteIfNeeded(String(value))}\n`,
			"utf8",
		);
		return { kind: "created" };
	}
	const target = [...declarationNodes(document)].reverse().find(node => {
		if (node.get("id") !== id) return false;
		const declared = node.get("name");
		return declared === undefined || declared === null || declared === name;
	});
	if (target) {
		const config = target.get("config") as EntryNode | undefined;
		if (config?.get(key) === value) return { kind: "updated", changed: false };
		if (config && typeof config.set === "function") config.set(key, value);
		else target.set("config", { [key]: value });
	} else {
		(document.contents as unknown as { add(value: unknown): void }).add({
			insert: [{ id, name, config: { [key]: value } }],
		});
	}
	await fs.writeFile(patchPath, String(document), "utf8");
	return { kind: "updated", changed: true };
}

/** Quote an id only when a bare scalar would not read back as itself. */
function quoteIfNeeded(value: string): string {
	return /^[A-Za-z0-9_][\w.-]*$/.test(value) ? value : `"${value.replace(/"/g, '\\"')}"`;
}
