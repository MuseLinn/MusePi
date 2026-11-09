import { describe, expect, it } from "bun:test";
import { buildReloadReminder, type ReloadSnapshot } from "@musepi/pi-coding-agent/session/reload-reminder";

function snapshot(contextFiles: Record<string, string>, skills: string[] = []): ReloadSnapshot {
	return { contextFiles: new Map(Object.entries(contextFiles)), skills };
}

const noDirectories = { added: [], removed: [] };

describe("buildReloadReminder", () => {
	it("stays silent when the reload changed nothing", () => {
		const before = snapshot({ "/repo/AGENTS.md": "rules" }, ["review\tReview changes"]);
		const after = snapshot({ "/repo/AGENTS.md": "rules" }, ["review\tReview changes"]);

		expect(buildReloadReminder(before, after, noDirectories, "/repo")).toBeNull();
	});

	it("skips the context section when either read failed", () => {
		const before: ReloadSnapshot = { contextFiles: null, skills: [] };

		expect(buildReloadReminder(before, snapshot({ "/repo/AGENTS.md": "new" }), noDirectories, "/repo")).toBeNull();
	});

	it("reports modified, deleted and newly injected context files", () => {
		const before = snapshot({
			"/repo/AGENTS.md": "old",
			"/repo/gone.md": "gone",
		});
		const after = snapshot({
			"/repo/AGENTS.md": "new",
			"/repo/nested/AGENTS.md": "nested",
		});

		const reminder = buildReloadReminder(before, after, noDirectories, "/repo");

		expect(reminder).toContain("/repo/AGENTS.md");
		expect(reminder).toContain("/repo/gone.md (deleted)");
		expect(reminder).toContain("/repo/nested/AGENTS.md (not previously injected)");
		expect(reminder).toContain("Read the current file(s)");
	});

	it("replaces the skill listing when the catalog changes", () => {
		const before = snapshot({}, ["review\tOld description"]);
		const after = snapshot({}, ["review\tNew description", "deploy\tShip it"]);

		const reminder = buildReloadReminder(before, after, noDirectories, "/repo");

		expect(reminder).toContain("The skill catalog changed");
		expect(reminder).toContain("- review: New description");
		expect(reminder).toContain("- deploy: Ship it");
	});

	it("reports workspace directory changes without moving the session cwd", () => {
		const current = snapshot({});

		const reminder = buildReloadReminder(
			current,
			current,
			{ added: ["D:/Projects/references"], removed: ["D:/Projects/old"] },
			"D:/Projects/MusePi",
		);

		expect(reminder).toContain("- added: D:/Projects/references");
		expect(reminder).toContain("- removed: D:/Projects/old");
		expect(reminder).toContain("Session cwd remains D:/Projects/MusePi.");
	});

	it("wraps the merged reminder in a system-reminder block", () => {
		const reminder = buildReloadReminder(
			snapshot({ "/repo/AGENTS.md": "old" }),
			snapshot({ "/repo/AGENTS.md": "new" }),
			{ added: [], removed: [] },
			"/repo",
		);

		expect(reminder?.startsWith("<system-reminder>\n")).toBe(true);
		expect(reminder?.endsWith("\n</system-reminder>")).toBe(true);
	});
});
