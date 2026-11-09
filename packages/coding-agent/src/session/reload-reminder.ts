/**
 * Builds the hidden reminder a session reload leaves for the model.
 *
 * Kimi sends one reminder per changed catalog and none when nothing changed.
 * MusePi has a single reload variant, so the changed catalogs are merged into
 * one `<system-reminder>`; an unchanged reload stays silent.
 */

export interface ReloadSnapshot {
	/**
	 * Context instruction files (AGENTS.md, CLAUDE.md, …) keyed by path, or
	 * `null` when discovery itself failed — a failed read must not be diffed as
	 * "every file disappeared".
	 */
	contextFiles: Map<string, string> | null;
	/** `name\tdescription` per skill in prompt order. */
	skills: string[];
}

export interface ReloadWorkspaceDirectories {
	added: string[];
	removed: string[];
}

export function buildReloadReminder(
	before: ReloadSnapshot,
	after: ReloadSnapshot,
	workspaceDirectories: ReloadWorkspaceDirectories,
	cwd: string,
): string | null {
	const lines: string[] = [];
	const beforeFiles = before.contextFiles;
	const afterFiles = after.contextFiles;
	if (beforeFiles && afterFiles) {
		const modified: string[] = [];
		const added: string[] = [];
		for (const [filePath, content] of afterFiles) {
			const previous = beforeFiles.get(filePath);
			if (previous === undefined) added.push(filePath);
			else if (previous !== content) modified.push(filePath);
		}
		const removed = [...beforeFiles.keys()].filter(filePath => !afterFiles.has(filePath));
		if (modified.length > 0 || added.length > 0 || removed.length > 0) {
			lines.push(
				"The AGENTS.md instruction file(s) below changed on disk after they were injected into the system prompt:",
			);
			for (const filePath of modified) lines.push(`- ${filePath}`);
			for (const filePath of removed) lines.push(`- ${filePath} (deleted)`);
			for (const filePath of added) lines.push(`- ${filePath} (not previously injected)`);
			lines.push("Read the current file(s) and follow the latest contents; the injected copies are stale.");
		}
	}
	if (before.skills.join("\n") !== after.skills.join("\n")) {
		lines.push("The skill catalog changed since the system prompt was rendered; this listing replaces it:");
		if (after.skills.length === 0) lines.push("- no skills are currently available");
		for (const skill of after.skills) {
			const [name, description = ""] = skill.split("\t");
			lines.push(`- ${name}: ${description}`);
		}
	}
	if (workspaceDirectories.added.length > 0 || workspaceDirectories.removed.length > 0) {
		lines.push("Project directory configuration changed:");
		for (const directory of workspaceDirectories.added) lines.push(`- added: ${directory}`);
		for (const directory of workspaceDirectories.removed) lines.push(`- removed: ${directory}`);
		lines.push(`Session cwd remains ${cwd}.`);
	}
	if (lines.length === 0) return null;
	return `<system-reminder>\n${lines.join("\n")}\n</system-reminder>`;
}
