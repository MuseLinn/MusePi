import { agents } from "./agents.js";
import { collab } from "./collab.js";
import { composer } from "./composer.js";
import { context } from "./context.js";
import { guest } from "./guest.js";
import { companion } from "./companion.js";
import { general } from "./general.js";
import { sessions } from "./sessions.js";
import { settings } from "./settings.js";
import { shell } from "./shell.js";
import { tools } from "./tools.js";
import { transcript } from "./transcript.js";

/**
 * zh-CN translation map — merged from per-domain modules (shell, composer,
 * settings, …) so keys are edited next to their feature. `TranslationKey`
 * is derived from this merged surface, so the domains stay type-checked
 * against every `t()` call site.
 */
export const zhCN = {
	...shell,
	...composer,
	...sessions,
	...context,
	...collab,
	...transcript,
	...settings,
	...agents,
	...tools,
	...companion,
	...general,
	...guest,
} as const;

// Module-load duplicate guard: a key landing in two domains silently
// shadows with spread — fail loudly instead of shipping a dropped
// translation. Cheap (~3.5k key iterations) and runs in prod.
{
	const parts = {
		shell,
		composer,
		sessions,
		context,
		collab,
		transcript,
		settings,
		agents,
		tools,
		companion,
		general,
		guest,
	};
	const seen = new Map<string, string>();
	for (const [file, map] of Object.entries(parts)) {
		for (const key of Object.keys(map)) {
			const prev = seen.get(key);
			if (prev !== undefined) {
				throw new Error(`duplicate i18n key "${key}" in zh-CN (${prev} and ${file})`);
			}
			seen.set(key, file);
		}
	}
}
