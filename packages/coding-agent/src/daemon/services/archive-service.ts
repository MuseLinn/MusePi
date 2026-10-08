/**
 * Archive service — zip a selection of session files.
 *
 * Seam declaration (M2.4 discipline):
 *   name + ns   : `daemon/services/archive-service` · service key `archive`
 *   input       : RPC routes `archive.build` / `archive.status` (polled pair);
 *                 selection paths are absolute in the same namespace `fs.*`
 *                 already reads from
 *   output      : `{ id, entries }` from build; `{ state, done, total, bytes,
 *                 size?, path?, error? }` from status; the zip itself is a file
 *                 under the agent dir, fetched through `fs.readBytes` — there
 *                 is deliberately no download route, because the daemon answers
 *                 RPC over one WebSocket and has no REST surface for a GET
 *   lifecycle   : stateless at rest — `start`/`stop` unimplemented. A build
 *                 runs detached after the RPC returns and dies with the
 *                 process; finished builds and their files expire after a TTL
 *   enable/stop : always-on. There is no setting that makes reading files the
 *                 caller could already read unsafe enough to gate
 *   conflict    : `HostServices.register` rejects a duplicate key; route
 *                 ownership is enforced by route-coverage in both directions
 *   inspection  : `bun test src/daemon/services/route-coverage.test.ts` for the
 *                 seam, `test/daemon/archive-service.test.ts` for behavior;
 *                 a live build is observable only through `archive.status`.
 *
 * Why the contract is build-then-poll rather than one long RPC: a selection
 * that expands to a large tree takes seconds to read and write, and a client
 * waiting on a single request cannot tell "working" from "hung" — the same
 * reason the installer is a job with a state machine. The walk and count happen
 * before the RPC returns, so an empty or absurd selection is refused without
 * ever starting a build, and `entries` gives the poller its denominator.
 *
 * Two trust decisions, stated rather than implied:
 *
 * The output path is fenced. The build id is generated here, but a display name
 * from the caller becomes part of the filename — unfiltered, `../../x` would
 * let a request write outside the directory this service owns. So only
 * characters a filename can legitimately carry survive, inside the root.
 *
 * The selection is not fenced. Every file RPC in this daemon reads whatever
 * absolute path it is handed (`fs.readBytes` has no fence), the threat model is
 * a local app on a local disk, and a fence here would only break legitimate
 * selections while pretending to add safety.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getAgentDir } from "@musepi/pi-utils";
import { ZipWriter } from "../zip-writer";
import type { DaemonService } from "./types";

/** Per-build state, as reported by `archive.status`. */
export interface ArchiveBuildState {
	state: "building" | "ready" | "error";
	/** Entries finished so far. */
	done: number;
	/** Entries the archive will contain — known before the build starts. */
	total: number;
	/** Uncompressed bytes read so far. */
	bytes: number;
	/** Only when `state === "ready"`: the zip's byte size and where it is. */
	size?: number;
	path?: string;
	/** Only when `state === "error"`. */
	error?: string;
}

/** Refusal before a build exists. Distinct from a build that failed later:
 *  the caller never got an id, so there is nothing to poll. */
export type ArchiveBuildResult = { id: string; entries: number } | { error: string };

/** Status lookup: an id this process never heard of is an error, not an empty
 *  state — silently reporting "building" forever would strand the poller. */
export type ArchiveStatusResult = ArchiveBuildState | { error: string };

/** Selection cap. Beyond this the request is a mistake or an attack; either
 *  way walking it is not what a panel's "zip these files" means. */
const MAX_SELECTION = 2000;
/** Expanded-file cap. A directory selection can blow past the selection cap,
 *  and stopping there keeps a build's memory and runtime bounded. Unlike the
 *  selection cap this one cannot be checked before the walk, so hitting it
 *  refuses the build rather than truncating it — see {@link collect}. */
const MAX_ENTRIES = 50_000;
/** Directory recursion cap — deeper than any real source tree a session
 *  selects, and enough to stop a symlink cycle from running until the entry
 *  cap fills. */
const MAX_DIR_DEPTH = 32;
/** A finished or failed build stays pollable this long. Long enough for a slow
 *  client to notice it is ready; short enough that the archive directory is
 *  not where a daemon accumulates files forever. */
const BUILD_TTL_MS = 10 * 60_000;
/** Concurrent builds per session. Two is already generous — a third means the
 *  client is re-requesting without reading the first id. */
const MAX_ACTIVE_BUILDS_PER_SESSION = 2;

interface BuildRecord {
	readonly id: string;
	readonly sessionId: string;
	readonly state: ArchiveBuildState;
	/** Set when the build reaches a terminal state; 0 while running. */
	finishedAtMs: number;
}

/** What the host gives the service — the writable root, isolated for tests. */
export interface ArchiveServiceDeps {
	/** Directory finished archives are written to. */
	archivesDir?: () => string;
}

/** One selected file, with its name inside the archive. */
interface SelectedFile {
	readonly abs: string;
	readonly name: string;
	readonly size: number;
}

/** The walk hit the entry cap mid-selection. */
const TOO_LARGE = Symbol("too large");

/**
 * Give a file its slot in the archive's name space.
 *
 * Two selected directories can each contain a `README.md`, and a zip with two
 * entries of one name is not two files — readers pick one and the person never
 * learns the other was there. Collisions get a numeric suffix, which is both
 * unique and recognisable as "this one was displaced".
 */
function uniqueName(name: string, taken: Set<string>): string {
	if (!taken.has(name)) {
		taken.add(name);
		return name;
	}
	const dot = name.lastIndexOf(".");
	const stem = dot > 0 ? name.slice(0, dot) : name;
	const ext = dot > 0 ? name.slice(dot) : "";
	for (let n = 2; ; n++) {
		const candidate = `${stem}-${n}${ext}`;
		if (!taken.has(candidate)) {
			taken.add(candidate);
			return candidate;
		}
	}
}

/**
 * Expand the selection into files.
 *
 * Unreadable paths are skipped — a selection where one file vanished still
 * archives the rest rather than failing the whole build over a missing row.
 * The cap is a refusal, not a truncation: an archive is only useful if the
 * person trusts it to be complete, and a quiet half-tree is worse than a "no".
 */
async function collect(paths: readonly string[]): Promise<SelectedFile[] | typeof TOO_LARGE> {
	const out: SelectedFile[] = [];
	const taken = new Set<string>();
	const add = (abs: string, name: string, size: number): boolean => {
		if (out.length >= MAX_ENTRIES) return false;
		out.push({ abs, name: uniqueName(name, taken), size });
		return true;
	};
	for (const raw of paths) {
		const abs = path.resolve(raw);
		let st: Awaited<ReturnType<typeof fs.stat>>;
		try {
			st = await fs.stat(abs);
		} catch {
			continue;
		}
		if (st.isDirectory()) {
			if (!(await walkDir(abs, abs, add))) return TOO_LARGE;
		} else if (!add(abs, path.basename(abs), st.size)) {
			return TOO_LARGE;
		}
	}
	return out;
}

/** Recursive directory walk; `add` returns false once the cap is hit. */
async function walkDir(
	root: string,
	current: string,
	add: (abs: string, name: string, size: number) => boolean,
): Promise<boolean> {
	let names: string[];
	try {
		names = (await fs.readdir(current)).sort();
	} catch {
		return true;
	}
	for (const name of names) {
		const abs = path.join(current, name);
		let st: Awaited<ReturnType<typeof fs.stat>>;
		try {
			st = await fs.stat(abs);
		} catch {
			continue;
		}
		if (st.isDirectory()) {
			// Depth is counted from the selected root; a cycle would burn
			// through the entry cap long before the root-relative depth hits the
			// limit, so the check is a belt for the suspenders.
			if (path.relative(root, abs).split(path.sep).filter(Boolean).length > MAX_DIR_DEPTH) continue;
			if (!(await walkDir(root, abs, add))) return false;
		} else if (!add(abs, path.relative(root, abs).split(path.sep).join("/"), st.size)) {
			return false;
		}
	}
	return true;
}

export class ArchiveService implements DaemonService {
	readonly key = "archive";
	readonly routes = {
		"archive.build": "build",
		"archive.status": "status",
	} as const;

	readonly #archivesDir: () => string;
	/** id → record. The only place a build's progress lives. */
	readonly #builds = new Map<string, BuildRecord>();
	#seq = 0;

	constructor(deps: ArchiveServiceDeps = {}) {
		this.#archivesDir = deps.archivesDir ?? (() => path.join(getAgentDir(), "archives"));
	}

	/**
	 * `archive.build` — fence, walk, then build in the background.
	 *
	 * Returns as soon as the selection is counted; nothing is written yet. The
	 * client polls {@link status} with the returned id.
	 */
	async build(params: { sessionId?: string; paths?: readonly string[]; name?: string }): Promise<ArchiveBuildResult> {
		this.#expire();
		const paths = params.paths ?? [];
		if (paths.length === 0) return { error: "paths required (empty selection)" };
		if (paths.length > MAX_SELECTION) return { error: `selection too large (max ${MAX_SELECTION})` };

		const active = [...this.#builds.values()].filter(
			r => r.sessionId === (params.sessionId ?? "") && r.state.state === "building",
		).length;
		if (active >= MAX_ACTIVE_BUILDS_PER_SESSION) {
			return { error: `session already has ${active} builds running` };
		}

		const collected = await collect(paths.map(String));
		if (collected === TOO_LARGE) return { error: `selection expands to more than ${MAX_ENTRIES} files` };
		if (collected.length === 0) return { error: "selection contains no readable files" };

		const id = `${Date.now().toString(36)}-${(++this.#seq).toString(36)}`;
		const record: BuildRecord = {
			id,
			sessionId: params.sessionId ?? "",
			state: { state: "building", done: 0, total: collected.length, bytes: 0 },
			finishedAtMs: 0,
		};
		this.#builds.set(id, record);
		// Detached on purpose, and awaited nowhere: a zip failure must reach the
		// record's state and the person polling, not the process's
		// unhandledRejection handler, which in this host means a postmortem that
		// drops every live session.
		void this.#run(record, collected, this.#target(id, params.name));
		return { id, entries: collected.length };
	}

	/**
	 * `archive.status` — poll one build.
	 *
	 * The state object is returned live rather than copied: a poller reading it
	 * takes its own snapshot, and a copy per poll would be a per-request
	 * allocation for no change in what the client can observe.
	 */
	status(params: { id?: string }): ArchiveStatusResult {
		const record = this.#builds.get(String(params.id ?? ""));
		if (!record) return { error: "unknown or expired build" };
		return record.state;
	}

	/** Where a build's zip lands. The id is ours; only the sanitized display
	 *  name is the caller's, and it can add no path segments. */
	#target(id: string, name: string | undefined): string {
		return path.join(this.#archivesDir(), `${id}${sanitizeSuffix(name)}.zip`);
	}

	/** The detached build. */
	async #run(record: BuildRecord, files: readonly SelectedFile[], zipPath: string): Promise<void> {
		const state = record.state;
		try {
			const zip = new ZipWriter();
			// Directory entries are emitted once each, before the files that
			// live under them, so unzippers create the tree before its leaves.
			// The seen set is what makes "once" true: two files in `deep/` would
			// otherwise each add a `deep/` entry, and a zip carrying the same
			// directory twice is a malformed archive some readers reject.
			const addedDirs = new Set<string>();
			const addDirsOf = (name: string): void => {
				const parts = name.split("/");
				for (let i = 1; i < parts.length; i++) {
					const dir = `${parts.slice(0, i).join("/")}/`;
					if (addedDirs.has(dir)) continue;
					addedDirs.add(dir);
					zip.addDirectory(dir);
				}
			};
			for (const file of files) {
				addDirsOf(file.name);
				const bytes = new Uint8Array(await Bun.file(file.abs).arrayBuffer());
				zip.addFile(file.name, bytes);
				state.done += 1;
				state.bytes += bytes.length;
			}
			const data = zip.finish();
			// `Bun.write` creates the parent directory; `fs.writeFile` does not,
			// and this service owns a directory under the agent dir that only
			// exists once a first build makes it.
			await Bun.write(zipPath, data);
			state.size = data.length;
			state.path = zipPath;
			state.state = "ready";
		} catch (err) {
			state.error = err instanceof Error ? err.message : String(err);
			state.state = "error";
		} finally {
			record.finishedAtMs = Date.now();
		}
	}

	/** Expire terminal builds and their files. Opportunistic — called on each
	 *  request rather than on a timer, because a build nobody polls any more is
	 *  exactly the one whose file is safe to remove. */
	#expire(): void {
		const now = Date.now();
		for (const [id, record] of this.#builds) {
			if (record.state.state === "building" || now - record.finishedAtMs <= BUILD_TTL_MS) continue;
			this.#builds.delete(id);
			const file = record.state.path;
			if (file !== undefined) void fs.rm(file, { force: true }).catch(() => {});
		}
	}
}

/**
 * Keep a caller-supplied display name, and nothing else.
 *
 * The value is appended to a generated id inside the service's own directory,
 * so what must be removed is anything that could escape it: separators and the
 * parent-traversal they spell. Everything else a filename legitimately carries
 * (letters, digits, dot, dash, underscore, and non-ASCII) survives, which keeps
 * a Chinese archive name readable in the file the person downloads.
 */
export function sanitizeSuffix(name: string | undefined): string {
	if (name === undefined) return "";
	const cleaned = name
		.replace(/[\\/:*?"<>|]/g, "")
		.replace(/\.\./g, "")
		.replace(/\s+/g, "-")
		.slice(0, 40);
	return cleaned === "" ? "" : `-${cleaned}`;
}
