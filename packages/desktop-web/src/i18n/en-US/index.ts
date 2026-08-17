import { agents } from "./agents.js";
import { collab } from "./collab.js";
import { composer } from "./composer.js";
import { context } from "./context.js";
import { guest } from "./guest.js";
import { pet } from "./pet.js";
import { sessions } from "./sessions.js";
import { settings } from "./settings.js";
import { shell } from "./shell.js";
import { tools } from "./tools.js";
import { transcript } from "./transcript.js";

/**
 * en-US translation map — merged from per-domain modules mirroring zh-CN/
 * (same domain files, English values; English keys pass through as-is).
 * Must keep the same key set as zh-CN — enforced at compile time: every
 * en domain file is `satisfies Record<…Key, string>` against its zh
 * counterpart, so a missing or extra en key is a build error.
 */
export const enUS = {
	...shell,
	...composer,
	...sessions,
	...context,
	...collab,
	...transcript,
	...settings,
	...agents,
	...tools,
	...pet,
	...guest,
} as const;

// Module-load duplicate guard (mirror of zh-CN/index.ts).
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
		pet,
		guest,
	};
	const seen = new Map<string, string>();
	for (const [file, map] of Object.entries(parts)) {
		for (const key of Object.keys(map)) {
			const prev = seen.get(key);
			if (prev !== undefined) {
				throw new Error(`duplicate i18n key "${key}" in en-US (${prev} and ${file})`);
			}
			seen.set(key, file);
		}
	}
}
