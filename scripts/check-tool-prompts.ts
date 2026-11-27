#!/usr/bin/env bun

import { join } from "node:path";
/**
 * Gate: a tool's model-facing prose exists, and nothing names a tool that is not there.
 *
 * Why a gate: a tool and its prose are two halves of one contract, and nothing
 * else in the pipeline compares them. Renaming `todo` to `todos` without moving
 * `prompts/tools/todo.md`, or shipping a tool whose description is an inline
 * string, produces a model told about a tool it cannot call — or handed a tool
 * with no guidance. Both look fine in review and fail only in production.
 *
 * What it checks:
 *   1. Every tool class under `src/tools/` names its prose via a
 *      `prompts/tools/*.md` import, or the whole file sits in INLINE_PROSE.
 *   2. Every name in the built-in vocabulary resolves to a prompt file.
 *   3. No single tool description is assembled inline (`.agents/rules/code-quality.md`).
 *
 * Skills are deliberately out of scope: a backticked word in prose is a
 * parameter value, a widget type or a shell command far more often than a tool
 * name. Which tools a skill teaches is a review question, not a regex.
 *
 * usage: bun scripts/check-tool-prompts.ts [--report]
 */
import { Glob } from "bun";

const ROOT = join(import.meta.dir, "..");
const TOOLS_DIR = "packages/coding-agent/src/tools";
const PROMPTS_DIR = "packages/coding-agent/src/prompts/tools";

/**
 * Tool files whose prose is not a standalone prompt: a control-flow tool, a
 * bundle of tools described by one schema, or a vocabulary that lives in the
 * system prompt. Each entry says what replaced the file.
 */
const INLINE_PROSE: Readonly<Record<string, string>> = {
	"think.ts": "scratchpad: described by the system prompt, not a tool prompt",
	"yield.ts": "control-flow tool: `yield` is described by the task contract",
	"vibe.ts": "five `vibe_*` tools share one schema and result contract; no prose section",
};

/** Prompt file for a name whose prose is shared under another name. */
const SHARED_PROMPT: Readonly<Record<string, string>> = {
	edit: "apply-patch",
	ast_edit: "ast-edit",
	ast_grep: "ast-grep",
	memory_edit: "memory-edit",
	inspect_image: "inspect-image",
	manage_skill: "manage-skill",
	notify_user: "notify-user",
	security_scan: "security-scan",
	connector_catalog: "connector-catalog",
	request_secret: "request-secret",
	request_login: "request-login",
	list_secrets: "list-secrets",
	web_search: "web-search",
};

/**
 * Plugin-shipped tools. Their descriptions come from the registering package
 * (`plugins/media/visuals`, `plugins/media/board`), which imports the
 * package's own `prompts/tools/*.md`; they are not core tool classes.
 */
const PLUGIN_TOOLS: ReadonlySet<string> = new Set(["widget", "board"]);

function stripComments(source: string): string {
	return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

async function toolFiles(): Promise<Array<{ file: string; names: string[]; source: string }>> {
	const out: Array<{ file: string; names: string[]; source: string }> = [];
	for await (const relative of new Glob(`./${TOOLS_DIR}/*.ts`).scan(ROOT)) {
		if (relative.includes(".test.")) continue;
		const source = await Bun.file(join(ROOT, relative)).text();
		const names = [...stripComments(source).matchAll(/readonly name = "([a-z0-9_]+)"/g)].map(
			match => match[1] as string,
		);
		if (names.length > 0) out.push({ file: relative.split(String.fromCharCode(92)).join("/"), names, source });
	}
	return out;
}

function vocabularyOf(builtinSource: string): Set<string> {
	const names = new Set<string>();
	for (const list of [
		/BUILTIN_TOOL_NAMES = \[([\s\S]*?)\]/,
		/PLUGIN_TOOL_NAMES = \[([\s\S]*?)\]/,
		/HIDDEN_TOOL_NAMES = \[([\s\S]*?)\]/,
	]) {
		const body = list.exec(builtinSource)?.[1] ?? "";
		for (const match of body.matchAll(/"([a-z0-9_]+)"/g)) names.add(match[1] as string);
	}
	return names;
}

async function main(): Promise<number> {
	const failures: string[] = [];
	const report = process.argv.includes("--report");

	const prompts = new Set<string>();
	for await (const relative of new Glob(`${PROMPTS_DIR}/*.md`).scan(ROOT)) {
		prompts.add(relative.slice(PROMPTS_DIR.length + 1, -3));
	}

	const files = await toolFiles();
	const promptFor = (name: string): string | undefined => {
		if (prompts.has(name)) return name;
		const shared = SHARED_PROMPT[name];
		return shared !== undefined && prompts.has(shared) ? shared : undefined;
	};

	for (const entry of files) {
		const base = entry.file.split("/").pop() ?? entry.file;
		const inline = INLINE_PROSE[base];
		const importedProse = [...entry.source.matchAll(/prompts\/tools\/([a-z0-9_-]+)\.md/g)].map(
			match => match[1] as string,
		);
		if (importedProse.length === 0 && inline === undefined) {
			failures.push(
				`${entry.file}: no prompts/tools/*.md import for ${entry.names.map(name => `"${name}"`).join(", ")} and no INLINE_PROSE entry`,
			);
		}
		for (const name of entry.names) {
			if (promptFor(name) === undefined && inline === undefined) {
				failures.push(`${entry.file}: tool "${name}" has no ${PROMPTS_DIR}/${name}.md (or a SHARED_PROMPT target)`);
			}
		}
		if (/readonly description = `/.test(entry.source)) {
			failures.push(`${entry.file}: a tool assembles its description inline; move it to ${PROMPTS_DIR}/<name>.md`);
		}
	}
	for (const file of Object.keys(INLINE_PROSE)) {
		if (!files.some(entry => entry.file.replace(/\\/g, "/").split("/").pop() === file)) {
			failures.push(`INLINE_PROSE names "${file}" but no such tool file exists; drop the stale entry`);
		}
	}

	const vocabulary = vocabularyOf(
		await Bun.file(join(ROOT, "packages/coding-agent/src/tools/builtin-names.ts")).text(),
	);
	for (const name of vocabulary) {
		if (promptFor(name) !== undefined || PLUGIN_TOOLS.has(name)) continue;
		const inline = files.some(
			entry => INLINE_PROSE[entry.file.split("/").pop() ?? ""] !== undefined && entry.names.includes(name),
		);
		if (!inline) failures.push(`builtin-names.ts lists "${name}" but no ${PROMPTS_DIR}/${name}.md resolves for it`);
	}

	if (report) {
		console.log(`tool prompts: ${files.length} tool file(s), ${prompts.size} prompt(s), ${vocabulary.size} name(s)`);
	}
	if (failures.length === 0) {
		console.log("tool-prompts: OK — every tool names its model-facing prose");
		return 0;
	}
	console.error(`tool-prompts: ${failures.length} problem(s)\n`);
	for (const failure of failures) console.error(`  ${failure}`);
	console.error("\nA tool and its prose are one contract: import the .md, or record why the tool has no prose.");
	return 1;
}

if (import.meta.main) process.exit(await main());
