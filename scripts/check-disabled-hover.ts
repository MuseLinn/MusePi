/**
 * Disabled-control hover guard — a control that cannot act must not react.
 *
 * A `:hover` rule that changes a disabled control's fill or colour is not a
 * harmless flourish: the connectors device-sign-in button is a disabled
 * accent-filled primary, and hovering it repainted the fill dark while the
 * label kept its accent ink — the button became unreadable in the one state
 * where its label ("Getting a device code…") is the only progress feedback.
 *
 * Contract: a class that defines a `:disabled` state must either exclude the
 * pointer in its hover rule (`:hover:not(:disabled)`) or provide an explicit
 * `:disabled:hover` reset (the two accepted escape hatches used by
 * `.sh-ask-option` and `.gui-panel-empty-item`).
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const ROOTS = ["apps", "packages"];
const SKIP = new Set(["node_modules", "dist", ".git", "build", "release", "__pycache__", "vendor", "rawfile"]);

function cssFiles(root: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		if (SKIP.has(entry.name) || entry.name.startsWith(".")) continue;
		const path = join(root, entry.name);
		// Generated bundles (mobile/harmony asset copies, vendored daemon
		// panels) repeat the source CSS; the source files are the contract.
		if (path.replace(/\\/g, "/").includes("/assets/public/")) continue;
		if (entry.isDirectory()) out.push(...cssFiles(path));
		else if (entry.isFile() && path.endsWith(".css")) out.push(path);
	}
	return out;
}

const RULE = /([^{}]+)\{([^{}]*)\}/g;
const PSEUDO_HOVER = /^\.([A-Za-z0-9_-]+):hover(.*)$/;

function audit(file: string): string[] {
	const text = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
	const disabledClasses = new Set<string>();
	const disabledHover = new Set<string>();
	const hovers: string[] = [];
	for (const match of text.matchAll(RULE)) {
		const selector = match[1].replace(/\s+/g, " ").trim();
		for (const part of selector.split(",")) {
			const trimmed = part.trim();
			const disabled = /^\.([A-Za-z0-9_-]+):disabled(?!:hover)$/.exec(trimmed);
			if (disabled) disabledClasses.add(disabled[1]);
			const disabledOnHover = /^\.([A-Za-z0-9_-]+):disabled:hover$/.exec(trimmed);
			if (disabledOnHover) disabledHover.add(disabledOnHover[1]);
			if (trimmed.includes(":hover")) hovers.push(trimmed);
		}
	}
	const offenders: string[] = [];
	for (const selector of hovers) {
		const match = PSEUDO_HOVER.exec(selector);
		if (!match) continue;
		const [, cls, rest] = match;
		if (!disabledClasses.has(cls) || disabledHover.has(cls)) continue;
		if (rest.includes("not(:disabled)")) continue;
		// Only plain hover rules are the defect; compound state rules such as
		// `.x:hover .child` style a descendant and are not the control itself.
		if (rest !== "") continue;
		offenders.push(selector);
	}
	return [...new Set(offenders)];
}

const files = ROOTS.flatMap(root => cssFiles(root));
const problems: { file: string; selector: string }[] = [];
for (const file of files) {
	for (const selector of audit(file)) problems.push({ file: relative(process.cwd(), file), selector });
}

if (problems.length > 0) {
	console.error(`disabled-hover: ${problems.length} hover rule(s) on disabled controls`);
	for (const problem of problems) console.error(`  ${problem.file}  ${problem.selector}`);
	console.error('Use ":hover:not(:disabled)" or an explicit ":disabled:hover" reset.');
	process.exit(1);
}
console.log(`disabled-hover: OK — ${files.length} stylesheet(s), no hover on disabled controls`);
