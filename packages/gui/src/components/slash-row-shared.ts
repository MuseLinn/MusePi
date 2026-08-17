import type { SlashEntry } from "./SlashRow";

/** Skill entries arrive as `skill:<name>` (the agent-side invocation
 *  form); display the bare name, insert the full token. */
export function slashDisplayName(entry: Pick<SlashEntry, "name">): string {
	return entry.name.startsWith("skill:") ? entry.name.slice("skill:".length) : entry.name;
}
