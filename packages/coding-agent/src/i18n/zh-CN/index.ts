// ============================================================
// MusePi zh-CN locale — Chinese translations for the TUI.
//
// Key naming: un-migrated copy uses English source text as the key. A touched
// feature owns a feature namespace module (e.g. settings-compaction.ts) whose
// zh dictionary defines the key set and whose en dictionary is checked against
// it; the barrel spreads that module into the flat map `t()` resolves.
//
// Split into per-domain modules (setup, settings, shell, …) so keys are
// edited next to their feature; this barrel merges them into the flat map
// `t()` resolves against. Duplicate keys across domains throw at module
// load instead of silently shadowing.
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
import { settingsCompaction } from "./settings-compaction.ts";
import { setup } from "./setup.ts";
import { shell } from "./shell.ts";
import { swarm } from "./swarm.ts";
import { tools } from "./tools.ts";
import { welcome } from "./welcome.ts";

export const zhCN: TranslationMap = {
	...setup,
	...shell,
	...settings,
	...settingsCompaction,
	...common,
	...swarm,
	...welcome,
	...dashboard,
	...selector,
	...auth,
	...tools,
	...commands,
	...mcp,
	...errors,
};

// Module-load duplicate guard: a key in two domains silently shadows with
// spread — fail loudly instead of shipping a dropped translation.
{
	const parts = {
		setup,
		shell,
		settings,
		settingsCompaction,
		common,
		swarm,
		welcome,
		dashboard,
		selector,
		auth,
		tools,
		commands,
		mcp,
		errors,
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
