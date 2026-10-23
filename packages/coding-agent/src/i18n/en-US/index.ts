// ============================================================
// MusePi en-US locale - English source strings for the TUI.
// Per-domain modules merged into the flat map `t()` resolves against.
// ============================================================

import type { TranslationMap } from "../index.ts";
import { auth } from "./auth.ts";
import { commands } from "./commands.ts";
import { common } from "./common.ts";
import { dashboard } from "./dashboard.ts";
import { errors } from "./errors.ts";
import { mcp } from "./mcp.ts";
import { selector } from "./selector.ts";
import { settings } from "./settings.ts";
import { setup } from "./setup.ts";
import { shell } from "./shell.ts";
import { swarm } from "./swarm.ts";
import { tools } from "./tools.ts";
import { welcome } from "./welcome.ts";

export const enUS: TranslationMap = {
	...auth,
	...commands,
	...common,
	...dashboard,
	...errors,
	...mcp,
	...selector,
	...settings,
	...setup,
	...shell,
	...swarm,
	...tools,
	...welcome,
};

// Module-load duplicate guard, mirroring the zh-CN barrel.
{
	const parts = {
		auth,
		commands,
		common,
		dashboard,
		errors,
		mcp,
		selector,
		settings,
		setup,
		shell,
		swarm,
		tools,
		welcome,
	};
	const seen = new Map<string, string>();
	for (const [file, map] of Object.entries(parts)) {
		for (const key of Object.keys(map)) {
			const prev = seen.get(key);
			if (prev !== undefined) {
				throw new Error(`duplicate i18n key "${key}" (${prev} and ${file})`);
			}
			seen.set(key, file);
		}
	}
}
