/**
 * `musepi import` — import sessions from another coding-agent.
 *
 * Mirrors the GUI `import.agents → import.sources → import.session` flow
 * but runs against the foreign session stores directly (no daemon needed):
 * it scans the source agent's session directories, lists candidates, and
 * persists a chosen one under a fresh MusePi session identity via
 * `persistForeignSession`. The foreign agent never needs to be running.
 */

import { Args, Command, Flags } from "@musepi/pi-utils/cli";
import { getAgentDir } from "@musepi/pi-utils";
import { importHelp as commandHelp } from "../cli/command-help";
import { createForeignSessionStore, foreignSessionSources, persistForeignSession } from "../session/foreign-session-import";
import type { ForeignSessionSource } from "../session/foreign-session-store";

export default class Import extends Command {
	static description = commandHelp.description;

	static args = {
		source: Args.string({
			description: "Agent to import from (list sources with --list)",
			required: false,
		}),
		id: Args.string({
			description: "Session id or path to import (required unless --list)",
			required: false,
		}),
	};

	static flags = {
		list: Flags.boolean({ char: "l", description: "List importable agent sources" }),
		sessions: Flags.boolean({ char: "s", description: "List sessions for the given source" }),
		cwd: Flags.string({ char: "c", description: "Import into a specific cwd (default session cwd)" }),
		json: Flags.boolean({ char: "j", description: "Emit machine-readable JSON" }),
	};

	static examples = [
		"musepi import --list",
		"musepi import claude --sessions",
		"musepi import musepi <session-id>",
		"musepi import --json --sessions",
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Import);

		if (flags.list) {
			this.#listSources(flags.json ?? false);
			return;
		}

		const source = args.source as ForeignSessionSource | undefined;
		if (!source) {
			process.stderr.write("Missing source. Run `musepi import --list` to see available agents.\n");
			process.exitCode = 2;
			return;
		}
		if (!foreignSessionSources().includes(source)) {
			process.stderr.write(`Unknown import source: ${source}\n`);
			process.exitCode = 2;
			return;
		}

		if (flags.sessions) {
			await this.#listSessions(source, flags.json ?? false);
			return;
		}

		if (!args.id) {
			process.stderr.write(
				`Missing session id. Run \`musepi import ${source} --sessions\` to list candidates.\n`,
			);
			process.exitCode = 2;
			return;
		}

		await this.#importSession(source, args.id, flags.cwd, flags.json ?? false);
	}

	#listSources(json: boolean): void {
		const sources = foreignSessionSources().map(source => ({
			source,
			name: this.#sourceName(source),
		}));
		if (json) {
			process.stdout.write(JSON.stringify(sources, null, 2) + "\n");
			return;
		}
		const pad = Math.max(...sources.map(s => s.source.length), 8);
		for (const { source, name } of sources) {
			process.stdout.write(`${source.padEnd(pad)} ${name}\n`);
		}
	}

	async #listSessions(source: ForeignSessionSource, json: boolean): Promise<void> {
		const store = createForeignSessionStore(source);
		let sessions;
		try {
			sessions = await store.list();
		} catch (error) {
			process.stderr.write(`Failed to scan ${source} sessions: ${(error as Error).message}\n`);
			process.exitCode = 1;
			return;
		}
		if (json) {
			process.stdout.write(
				JSON.stringify(
					sessions.map(s => ({
						id: s.id,
						path: s.path,
						cwd: s.cwd,
						title: s.title ?? "",
						messageCount: s.messageCount ?? 0,
						modified: s.modified.toISOString(),
					})),
					null,
					2,
				) + "\n",
			);
			return;
		}
		if (sessions.length === 0) {
			process.stdout.write(`No ${source} sessions found.\n`);
			return;
		}
		process.stdout.write(`${sessions.length} session(s) from ${this.#sourceName(source)}:\n`);
		for (const s of sessions.slice(0, 100)) {
			const count = s.messageCount ? ` (${s.messageCount} msgs)` : "";
			const title = s.title ? ` — ${s.title}` : "";
			process.stdout.write(`  ${s.id}${title}${count}\n`);
			process.stdout.write(`      path: ${s.path}\n`);
		}
	}

	async #importSession(
		source: ForeignSessionSource,
		id: string,
		cwd: string | undefined,
		json: boolean,
	): Promise<void> {
		const store = createForeignSessionStore(source);
		let sessions;
		try {
			sessions = await store.list();
		} catch (error) {
			process.stderr.write(`Failed to scan ${source} sessions: ${(error as Error).message}\n`);
			process.exitCode = 1;
			return;
		}
		const match =
			sessions.find(s => s.id === id) ??
			sessions.find(s => s.path === id) ??
			sessions.find(s => s.path.endsWith(id));
		if (!match) {
			process.stderr.write(`Session not found in ${source}: ${id}. Run \`musepi import ${source} --sessions\` to list.\n`);
			process.exitCode = 1;
			return;
		}

		const sessionDir = cwd ?? getAgentDir();
		process.stdout.write(`Importing ${match.id} from ${this.#sourceName(source)}...\n`);
		const imported = await persistForeignSession(store, match, {
			fallbackCwd: cwd ?? getAgentDir(),
			sessionDir,
			suppressBreadcrumb: true,
		});
		const sessionFile = imported.getSessionFile();
		await imported.close();
		if (!sessionFile) {
			process.stderr.write("Failed to persist imported session.\n");
			process.exitCode = 1;
			return;
		}
		if (json) {
			process.stdout.write(JSON.stringify({ ok: true, source, sourceId: match.id, sessionFile }) + "\n");
		} else {
			process.stdout.write(`Imported ${match.id} → ${sessionFile}\n`);
		}
	}

	#sourceName(source: ForeignSessionSource): string {
		switch (source) {
			case "claude":
				return "Claude";
			case "codex":
				return "Codex";
			case "grok":
				return "Grok";
			case "kimicode":
				return "Kimi Code";
			case "musepi":
				return "MusePi";
			case "omp":
				return "OMP";
			case "opencode":
				return "OpenCode";
			case "pi":
				return "Pi";
		}
	}
}
