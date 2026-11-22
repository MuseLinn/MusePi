import { join, resolve } from "node:path";

/**
 * Word ceilings for the documents every task loads or consults first.
 *
 * A ceiling is frozen at the size the doc has when it is adopted and may only
 * fall as content is relocated to an ADR or deleted. Raising one needs an
 * explicit decision in the change description — a budget that silently follows
 * growth is not a budget.
 */

const WORD = /\S+/g;

export function wordCount(source: string): number {
	return source.match(WORD)?.length ?? 0;
}

interface Budget {
	rule: string;
	files: Record<string, number>;
}

async function main(): Promise<void> {
	const rootFlag = process.argv.indexOf("--root");
	const root = resolve(rootFlag >= 0 ? process.argv[rootFlag + 1] : resolve(import.meta.dir, ".."));
	const report = process.argv.includes("--report");
	const budget = (await Bun.file(join(root, "docs/doc-budgets.json")).json()) as Budget;
	const failures: string[] = [];

	for (const [path, ceiling] of Object.entries(budget.files)) {
		const words = wordCount(await Bun.file(join(root, path)).text());
		if (report) console.log(`${words}\t${ceiling}\t${path}`);
		if (words > ceiling) {
			failures.push(
				`${path}: ${words} words, ceiling ${ceiling}. Relocate the detail to its owning doc or ADR; ` +
					"raise the ceiling only with a stated reason in the change.",
			);
		}
	}

	if (failures.length > 0) {
		for (const failure of failures) console.error(failure);
		process.exit(1);
	}
	console.log(`doc budgets: ${Object.keys(budget.files).length} files within ceiling`);
}

if (import.meta.main) await main();
