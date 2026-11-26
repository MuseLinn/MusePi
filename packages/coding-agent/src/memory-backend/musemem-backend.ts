import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getAgentDbPath } from "@musepi/pi-utils";
import {
	buildMemoryToolDeveloperInstructions,
	clearGlobalMemoryData,
	clearMemoryData,
	clearMemoryToolDeveloperInstructionsCache,
	enqueueMemoryConsolidation,
	getGlobalMemoryRoot,
	getMemoryRoot,
	saveLearnedLesson,
	startMemoryStartupTask,
} from "../memories";
import type { MemoryBackend } from "./types";

const SUMMARY_FILE = "memory_summary.md";
const LONG_TERM_FILE = "MEMORY.md";
const LESSONS_FILE = "learned.md";

interface ArtifactFacts {
	exists: boolean;
	bytes: number;
	mtimeMs: number;
}

interface LessonFacts {
	exists: boolean;
	count: number;
}

async function artifactFacts(file: string): Promise<ArtifactFacts> {
	try {
		const stat = await fs.stat(file);
		return { exists: true, bytes: stat.size, mtimeMs: stat.mtimeMs };
	} catch {
		return { exists: false, bytes: 0, mtimeMs: 0 };
	}
}

async function lessonFacts(file: string): Promise<LessonFacts> {
	try {
		const text = await Bun.file(file).text();
		return { exists: true, count: text.split("\n").filter(line => line.trimStart().startsWith("- ")).length };
	} catch {
		return { exists: false, count: 0 };
	}
}

async function skillCount(root: string): Promise<number> {
	try {
		const entries = await fs.readdir(path.join(root, "skills"), { withFileTypes: true });
		return entries.filter(entry => entry.isDirectory()).length;
	} catch {
		return 0;
	}
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatWhen(mtimeMs: number): string {
	return mtimeMs > 0 ? new Date(mtimeMs).toISOString() : "never";
}

function summarize(facts: ArtifactFacts): string {
	return facts.exists ? `${formatBytes(facts.bytes)} (updated ${formatWhen(facts.mtimeMs)})` : "absent";
}

/**
 * Wraps the existing `memories/` module as a `MemoryBackend`.
 *
 * The rollout-summarisation pipeline (rollouts → SQLite → memory_summary.md) is
 * delegated unchanged and stays project-scoped. On top of it, `save()` persists
 * `learn`-tool lessons to the project's `learned.md`, or to the cross-project
 * `_global/learned.md` when the caller passes `scope: "global"` and
 * `musemem.globalScope` allows it. Structured search is still unavailable.
 */
export const musememBackend: MemoryBackend = {
	id: "musemem",
	start(options) {
		startMemoryStartupTask(options);
	},
	async buildDeveloperInstructions(agentDir, _cwd, settings, session) {
		return buildMemoryToolDeveloperInstructions(agentDir, settings, session);
	},
	async clear(agentDir, cwd, session) {
		// Drop the session's cached snapshot first, then wipe disk state;
		// clearMemoryData also drops the by-root baseline so the startup refresh
		// cannot resurrect cleared lessons into the next session.
		clearMemoryToolDeveloperInstructionsCache(session);
		await clearMemoryData(agentDir, cwd);
	},
	async clearGlobal(agentDir, session) {
		clearMemoryToolDeveloperInstructionsCache(session);
		await clearGlobalMemoryData(agentDir);
	},
	async enqueue(agentDir, cwd) {
		enqueueMemoryConsolidation(agentDir, cwd);
	},
	async save(context, input) {
		const result = await saveLearnedLesson(context.agentDir, context.cwd, input);
		// The injected instructions read `learned.md`; drop this session's cached
		// snapshot so the next prompt rebuild carries the new lesson instead of
		// the frozen one.
		clearMemoryToolDeveloperInstructionsCache(context.session);
		return result;
	},
	workspaceDir(agentDir, cwd) {
		return getMemoryRoot(agentDir, cwd);
	},
	async status({ agentDir, cwd, session }) {
		const root = getMemoryRoot(agentDir, cwd);
		const [summary, lessons, globalLessons] = await Promise.all([
			artifactFacts(path.join(root, SUMMARY_FILE)),
			lessonFacts(path.join(root, LESSONS_FILE)),
			lessonFacts(path.join(getGlobalMemoryRoot(agentDir), LESSONS_FILE)),
		]);
		const globalScope = session?.settings?.get("musemem.globalScope") !== false;
		return {
			backend: "musemem" as const,
			active: true,
			writable: true,
			searchable: false,
			scope: path.basename(root),
			projectLessons: lessons.count,
			globalLessons: globalLessons.count,
			summaryBytes: summary.bytes,
			globalScope,
			message: `Summary: ${summary.exists ? formatBytes(summary.bytes) : "none"}; project lessons: ${lessons.count}; global lessons: ${globalScope ? globalLessons.count : "off"}.`,
		};
	},
	async stats(agentDir, cwd, session) {
		const root = getMemoryRoot(agentDir, cwd);
		const globalRoot = getGlobalMemoryRoot(agentDir);
		const [summary, longTerm, lessons, globalLessons, skills] = await Promise.all([
			artifactFacts(path.join(root, SUMMARY_FILE)),
			artifactFacts(path.join(root, LONG_TERM_FILE)),
			lessonFacts(path.join(root, LESSONS_FILE)),
			lessonFacts(path.join(globalRoot, LESSONS_FILE)),
			skillCount(root),
		]);
		const globalScope = session?.settings?.get("musemem.globalScope") !== false;
		return [
			`- Project memory root: \`${root}\``,
			`- Summary (${SUMMARY_FILE}): ${summarize(summary)}`,
			`- Long-term memory (${LONG_TERM_FILE}): ${summarize(longTerm)}`,
			`- Generated skills: ${skills}`,
			`- Project lessons: ${lessons.count}`,
			`- Global lessons: ${globalScope ? globalLessons.count : "disabled by musemem.globalScope"}`,
			`- Global lessons root: \`${globalRoot}\``,
			`- State DB: \`${getAgentDbPath(agentDir)}\``,
		].join("\n");
	},
	async diagnose(agentDir, cwd, session) {
		const root = getMemoryRoot(agentDir, cwd);
		const globalRoot = getGlobalMemoryRoot(agentDir);
		const [summary, lessons, globalLessons, db, skills] = await Promise.all([
			artifactFacts(path.join(root, SUMMARY_FILE)),
			lessonFacts(path.join(root, LESSONS_FILE)),
			lessonFacts(path.join(globalRoot, LESSONS_FILE)),
			artifactFacts(getAgentDbPath(agentDir)),
			skillCount(root),
		]);
		const globalScope = session?.settings?.get("musemem.globalScope") !== false;
		const warnings: string[] = [];
		if (!summary.exists) warnings.push("no consolidated summary yet — run `/memory enqueue` and start a session");
		if (!db.exists) warnings.push("state DB is missing — startup consolidation cannot claim work");
		if (lessons.exists && lessons.count === 0) warnings.push(`\`${LESSONS_FILE}\` exists but holds no lesson rows`);
		if (globalScope && globalLessons.exists && globalLessons.count === 0)
			warnings.push("global lessons file exists but holds no rows");
		return [
			`- Backend: musemem (\`memory.backend\`)`,
			`- Global scope: ${globalScope ? "on" : "off"}`,
			`- Project root: \`${root}\` (${summary.exists || lessons.exists ? "present" : "absent"})`,
			`- Summary: ${summary.exists ? formatBytes(summary.bytes) : "absent"}`,
			`- Project lessons: ${lessons.count}`,
			`- Global lessons: ${globalScope ? globalLessons.count : "off"}`,
			`- Generated skills: ${skills}`,
			`- State DB: ${db.exists ? formatBytes(db.bytes) : "absent"}`,
			...(warnings.length > 0 ? ["", `**Warnings**`, ...warnings.map(w => `- ${w}`)] : []),
		].join("\n");
	},
};
