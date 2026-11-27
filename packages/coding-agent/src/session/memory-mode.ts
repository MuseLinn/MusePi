export const SESSION_MEMORY_MODES = ["persistent", "incognito", "temporary"] as const;
export type SessionMemoryMode = (typeof SESSION_MEMORY_MODES)[number];

export function normalizeMemoryMode(value: unknown): SessionMemoryMode {
	return value === "incognito" || value === "temporary" ? value : "persistent";
}

export function sessionMemoryPolicy(mode: SessionMemoryMode): { read: boolean; write: boolean; goal: boolean } {
	return {
		read: mode !== "temporary",
		write: mode === "persistent",
		goal: mode === "persistent",
	};
}

export function memoryToolNamesForMode(mode: SessionMemoryMode): readonly string[] {
	if (mode === "temporary") return [];
	return mode === "incognito" ? ["recall", "reflect"] : ["retain", "recall", "reflect", "memory_edit", "learn"];
}
