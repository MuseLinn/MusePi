import * as fs from "node:fs/promises";
import { type ParsedHookConfig, parseHookConfig, type SubstitutionVars } from "./config";
import type { HookDialect } from "./types";

/**
 * Read one hook config file once, at plugin mount.
 *
 * A config that cannot be read or parsed does not fail the session: the
 * reference bridges warn and run no hooks, and a broken optional file must not
 * hold the agent hostage. The caller decides how to surface `error`.
 */
export async function loadHookConfigFile(
	file: string,
	dialect: HookDialect,
	vars: SubstitutionVars = {},
): Promise<{ parsed?: ParsedHookConfig; error?: string }> {
	let raw: string;
	try {
		raw = await fs.readFile(file, "utf8");
	} catch (error) {
		return { error: `cannot read hook config ${file}: ${error instanceof Error ? error.message : String(error)}` };
	}
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch (error) {
		return {
			error: `hook config ${file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
	try {
		return { parsed: parseHookConfig(value, dialect, vars) };
	} catch (error) {
		return { error: `hook config ${file} is invalid: ${error instanceof Error ? error.message : String(error)}` };
	}
}
