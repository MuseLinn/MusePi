/**
 * A card's workspace: the files that belong to one card on one board.
 *
 * A card is not just JSON. A generated page may need a CSV, an image, a JSON
 * snapshot — assets that must survive a reload and never leak into another
 * card's scope. So each card owns a folder:
 *
 *     ~/.musepi/boards/<boardId>/<widgetId>/
 *
 * Every path is resolved against that folder and nothing else. `..`, absolute
 * paths, NUL bytes and symlinks that escape the folder are refused: the model
 * writes these paths, and a path that leaves the card would let one card read
 * another board's files. This mirrors the scope rule Kimi's blueprint widgets
 * enforce ("Widget resource path escapes the Widget scope").
 *
 * Reads are the first slice. Writes need their own review — a model-authored
 * path that can overwrite is a different risk class from one that can only look.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** Card and board ids are folder names, so they are held to a folder's rules. */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** A reader that names a path is not a file-transfer tool. */
export const MAX_RESOURCE_BYTES = 512 * 1024;

/** Directory listings stay scannable; deeper trees belong to another tool. */
export const MAX_RESOURCE_ENTRIES = 200;

export class ResourceScopeError extends Error {}

function safeId(value: string, what: string): string {
	if (!SAFE_ID.test(value)) throw new ResourceScopeError(`invalid ${what} "${value}"`);
	// `.` and `..` satisfy the character rules, so they are excluded by name.
	if (value === "." || value === "..") throw new ResourceScopeError(`invalid ${what} "${value}"`);
	return value;
}

/** Where boards — and their card folders — live. `MUSEPI_BOARDS_DIR` moves the
 *  whole store, which is how a test points it at a scratch directory. */
export function boardsRoot(): string {
	const override = process.env.MUSEPI_BOARDS_DIR;
	return override?.trim() ? path.resolve(override) : path.join(os.homedir(), ".musepi", "boards");
}

export function cardDir(boardId: string, widgetId: string): string {
	return path.join(boardsRoot(), safeId(boardId, "board id"), safeId(widgetId, "card id"));
}

/**
 * Resolve a card-relative path, refusing anything that leaves the card.
 *
 * The containment check runs on the resolved path AND, when the target exists,
 * on its real path: a symlink inside the folder that points outside would pass
 * the first check and fail the second.
 */
export function resolveCardPath(boardId: string, widgetId: string, relative: string): string {
	if (relative.includes("\0")) throw new ResourceScopeError("path contains a NUL byte");
	if (path.isAbsolute(relative) || /^[A-Za-z]:/.test(relative)) {
		throw new ResourceScopeError("path must be relative to the card");
	}
	const root = cardDir(boardId, widgetId);
	const resolved = path.resolve(root, relative);
	if (resolved !== root && !resolved.startsWith(root + path.sep)) {
		throw new ResourceScopeError("path escapes the card scope");
	}
	if (fs.existsSync(resolved)) {
		const real = fs.realpathSync(resolved);
		const realRoot = fs.existsSync(root) ? fs.realpathSync(root) : root;
		if (real !== realRoot && !real.startsWith(realRoot + path.sep)) {
			throw new ResourceScopeError("path escapes the card scope through a link");
		}
	}
	return resolved;
}

/** The canonical file a card's generated content lives in, per type. Keeping
 *  it in the card folder (not the index) is what makes one card one directory:
 *  a long page never bloats `boards.json`, and the card's assets sit beside it. */
export const CARD_CONTENT_FILE: Record<string, string> = {
	block: "source.oui",
	html: "page.html",
};

/** The `data` field a card's content is kept in when it lives inline. */
export const CARD_CONTENT_FIELD: Record<string, string> = {
	block: "source",
	html: "html",
};

export interface CardResource {
	/** Card-relative, forward slashes — the form a page or the model uses. */
	path: string;
	bytes: number;
	kind: "file" | "dir";
}

/**
 * Everything in a card's folder, one level deep. A missing folder is an empty
 * card, not an error: a card need not have assets at all.
 */
export function listCardResources(boardId: string, widgetId: string): CardResource[] {
	const root = cardDir(boardId, widgetId);
	if (!fs.existsSync(root)) return [];
	const out: CardResource[] = [];
	for (const entry of fs.readdirSync(root, { withFileTypes: true }).slice(0, MAX_RESOURCE_ENTRIES)) {
		const full = path.join(root, entry.name);
		let bytes = 0;
		if (entry.isFile()) {
			try {
				bytes = fs.statSync(full).size;
			} catch {
				continue;
			}
		}
		out.push({ path: entry.name, bytes, kind: entry.isDirectory() ? "dir" : "file" });
	}
	return out;
}

/**
 * Read one text resource. Binary content is refused here rather than mangled:
 * a caller that needs bytes is a different capability, and pretending a PNG is
 * a string helps nobody.
 */
/**
 * Write one text resource, atomically.
 *
 * The scope rule is the read rule: a card writes only inside its own folder, so
 * one card cannot plant a file another card reads. The write goes to a sibling
 * temp file and is renamed into place, so a crash mid-write leaves the previous
 * content rather than half a file.
 */
export function writeCardText(boardId: string, widgetId: string, relative: string, text: string): number {
	if (Buffer.byteLength(text, "utf8") > MAX_RESOURCE_BYTES) {
		throw new ResourceScopeError(`write exceeds ${MAX_RESOURCE_BYTES} bytes: ${relative}`);
	}
	const file = resolveCardPath(boardId, widgetId, relative);
	const dir = path.dirname(file);
	fs.mkdirSync(dir, { recursive: true });
	const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.tmp`);
	fs.writeFileSync(tmp, text, "utf8");
	fs.renameSync(tmp, file);
	return Buffer.byteLength(text, "utf8");
}

export function readCardText(boardId: string, widgetId: string, relative: string): string {
	const file = resolveCardPath(boardId, widgetId, relative);
	const stat = fs.statSync(file);
	if (!stat.isFile()) throw new ResourceScopeError(`not a file: ${relative}`);
	if (stat.size > MAX_RESOURCE_BYTES) {
		throw new ResourceScopeError(`file exceeds ${MAX_RESOURCE_BYTES} bytes: ${relative}`);
	}
	const buffer = fs.readFileSync(file);
	if (buffer.includes(0)) throw new ResourceScopeError(`binary file, not text: ${relative}`);
	return buffer.toString("utf8");
}
