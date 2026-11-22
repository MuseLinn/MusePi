import { readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

/**
 * Dated-decision ratchet for living docs.
 *
 * A current-state document says how the system works now; a dated decision
 * belongs in one immutable `docs/adr/` file. The corpus already carries dated
 * decision markers from before that rule, so the baseline freezes each file's
 * count: it may fall as topics migrate, never rise.
 */

const PROCESS_RECORD_PREFIXES = ["docs/adr/", "docs/gui-verification/", "docs/review/", "docs/superpowers/"];
const DATED_MARKER = /\(20\d{2}-\d{2}-\d{2}/g;

export function countDatedMarkers(source: string): number {
	return (source.match(DATED_MARKER) ?? []).length;
}

async function markdownFiles(directory: string): Promise<string[]> {
	const files: string[] = [];
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) files.push(...(await markdownFiles(path)));
		else if (entry.isFile() && entry.name.endsWith(".md")) files.push(path);
	}
	return files;
}

interface Baseline {
	rule: string;
	files: Record<string, number>;
}

async function main(): Promise<void> {
	const rootFlag = process.argv.indexOf("--root");
	const root = resolve(rootFlag >= 0 ? process.argv[rootFlag + 1] : resolve(import.meta.dir, ".."));
	const report = process.argv.includes("--report");
	const baseline = (await Bun.file(join(root, "docs/doc-hygiene-baseline.json")).json()) as Baseline;
	const failures: string[] = [];
	const counts: Array<{ path: string; count: number; allowed: number }> = [];

	for (const file of await markdownFiles(join(root, "docs"))) {
		const path = relative(root, file).replaceAll("\\", "/");
		if (PROCESS_RECORD_PREFIXES.some(prefix => path.startsWith(prefix))) continue;
		const count = countDatedMarkers(await Bun.file(file).text());
		const allowed = baseline.files[path] ?? 0;
		counts.push({ path, count, allowed });
		if (count > allowed) {
			failures.push(
				`${path}: ${count} dated decision markers, baseline ${allowed}. ` +
					"Move the new decision to one docs/adr/<date>-<topic>.md file and keep this doc in the present tense.",
			);
		}
	}

	if (report) {
		const dated = counts.filter(entry => entry.count > 0).sort((a, b) => b.count - a.count);
		for (const entry of dated) console.log(`${entry.count}\t${entry.allowed}\t${entry.path}`);
		console.log(`${dated.length} docs, ${dated.reduce((sum, entry) => sum + entry.count, 0)} dated markers`);
	}

	if (failures.length > 0) {
		for (const failure of failures) console.error(failure);
		process.exit(1);
	}
	const total = counts.reduce((sum, entry) => sum + entry.count, 0);
	console.log(`docs hygiene: ${total} dated markers, none above baseline`);
}

if (import.meta.main) await main();
