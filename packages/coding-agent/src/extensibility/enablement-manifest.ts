/**
 * Read a plugin's enablement condition out of its manifest.
 *
 * The manifest is found by walking up from the entry file, which is the same
 * walk the compatibility gate does. That walk is reproduced here rather than
 * shared because the two answer different questions about the same files and
 * the gate's version has to keep working unchanged; the depth and the
 * file-is-a-directory step below are deliberately the same so a package can
 * never be found by one and missed by the other.
 *
 * A manifest with no condition yields `undefined`, which every consumer reads
 * as "load unconditionally".
 *
 * @module extensibility/enablement-manifest
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { logger } from "@musepi/pi-utils";
import { enablementHolds } from "./enablement";

/** How far up from an entry file a manifest may sit. */
const MAX_MANIFEST_DEPTH = 4;

/** The enablement condition a manifest declares. */
export interface EnablementCondition {
	/** The predicate name, or the keyword for the argument-taking form. */
	readonly condition: string;
	/** The argument, when the form takes one. */
	readonly argument?: string;
}

/**
 * The condition declared by the package an extension entry belongs to.
 *
 * @param extPath - the entry file or directory.
 * @returns the declared condition, or `undefined` when the manifest declares
 * none, declares it in a shape this build does not read, or cannot be read.
 */
export async function readEnablementCondition(extPath: string): Promise<EnablementCondition | undefined> {
	let dir = path.resolve(extPath);
	try {
		if ((await fs.stat(dir)).isFile()) dir = path.dirname(dir);
	} catch {
		// A path that does not exist has no manifest; the loader's own import
		// diagnostic is the right report for it.
		return undefined;
	}

	for (let depth = 0; depth < MAX_MANIFEST_DEPTH; depth++) {
		const pkgPath = path.join(dir, "package.json");
		let pkg: unknown;
		try {
			pkg = JSON.parse(await fs.readFile(pkgPath, "utf8"));
		} catch {
			const parent = path.dirname(dir);
			if (parent === dir) break;
			dir = parent;
			continue;
		}
		if (typeof pkg !== "object" || pkg === null) break;
		const fields = pkg as Record<string, unknown>;
		for (const blockField of ["musepi", "omp", "pi"]) {
			const block = fields[blockField];
			if (typeof block !== "object" || block === null) continue;
			const parsed = parseEnablementCondition((block as Record<string, unknown>).when);
			if (parsed !== undefined) return parsed;
		}
		break;
	}
	return undefined;
}

/**
 * Read a manifest's `when` field.
 *
 * Two shapes are accepted. A string names an argument-less condition; an object
 * names a condition and its argument, which is how `profileIs` carries the
 * profile it compares against. Any other shape is reported and read as absent,
 * so a manifest that gets this wrong loads rather than silently disappearing.
 */
function parseEnablementCondition(raw: unknown): EnablementCondition | undefined {
	if (typeof raw === "string") {
		return raw === "" ? undefined : { condition: raw };
	}
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		if (raw !== undefined) logger.warn("enablement: manifest `when` is not a string or object, ignoring", { raw });
		return undefined;
	}
	const fields = raw as Record<string, unknown>;
	const entries = Object.entries(fields).filter(([, value]) => typeof value === "string");
	if (entries.length !== 1) {
		logger.warn("enablement: manifest `when` must name exactly one condition, ignoring", { raw });
		return undefined;
	}
	const [condition, argument] = entries[0] as [string, string];
	return { condition, argument };
}

/**
 * Whether an extension's manifest lets it load right now.
 *
 * @param extPath - the entry file or directory.
 * @returns `true` when the plugin may load.
 */
export async function enablementAllowsPath(extPath: string): Promise<boolean> {
	const condition = await readEnablementCondition(extPath);
	if (condition === undefined) return true;
	return enablementHolds(condition.condition, condition.argument);
}
