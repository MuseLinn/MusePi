#!/usr/bin/env bun

/**
 * Guard the splitter grip component boundary (design spec 2026-11-16,
 * docs/gui-design.md §4, docs/gui-components.md).
 *
 * Why this exists: the grip pill was hand-written as
 * `<span className="gui-split-grip" />` at FOUR call sites (sidebar seam,
 * right-panel seam, dock horizontal seam, dock vertical seam) — the copy
 * count the repo's convergence rule calls a defect. A prose rule ("always use
 * the component") does not survive the next contributor; this check does.
 *
 * Contract:
 *   - only `components/SplitterGrip.tsx` may emit the `gui-split-grip` class
 *     in JSX. Every other file mounts `<SplitterGrip />`;
 *   - the class name must not reappear as a literal `className="gui-split-grip…"`
 *     anywhere else, because a copied span drifts silently: it keeps working
 *     while the component gains states it never gets;
 *   - the drag state must be per-seam. `body.gui-resizing` is global, so a
 *     style rule keyed on it lights every grip at once; the CSS must key the
 *     drag look on the pill's own `data-resizing`;
 *   - the retired `.gui-resize-grip` class must not come back.
 *
 * Exit 0 when compliant, exit 1 with a per-line report otherwise.
 */

import * as fs from "node:fs";
import * as path from "node:path";

const ROOTS = ["apps/desktop/src"];
const COMPONENT = "apps/desktop/src/components/SplitterGrip.tsx";
const STYLE = "apps/desktop/src/styles/gui-settings.css";

/** Files allowed to mention the class in JSX (the component itself). */
const OWNERS = new Set([COMPONENT]);

const HAND_WRITTEN_RE = /className\s*=\s*["'{`][^"'`}]*gui-split-grip/;
const RETIRED_RE = /gui-resize-grip/;

export interface Violation {
	file: string;
	line: number;
	detail: string;
}

function walk(dir: string, out: string[]): void {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === "node_modules" || entry.name === "dist") continue;
			walk(full, out);
			continue;
		}
		if (entry.isFile() && (entry.name.endsWith(".tsx") || entry.name.endsWith(".ts"))) out.push(full);
	}
}

export function scan(): Violation[] {
	const files: string[] = [];
	for (const root of ROOTS) walk(root, files);

	const violations: Violation[] = [];
	for (const file of files) {
		const rel = file.split(path.sep).join("/");
		const source = fs.readFileSync(file, "utf8");
		const lines = source.split(/\r?\n/);

		lines.forEach((line, index) => {
			const at = index + 1;
			if (RETIRED_RE.test(line)) {
				violations.push({ file: rel, line: at, detail: "retired .gui-resize-grip class" });
				return;
			}
			if (!OWNERS.has(rel) && HAND_WRITTEN_RE.test(line)) {
				violations.push({
					file: rel,
					line: at,
					detail: "hand-written grip span — mount <SplitterGrip /> instead",
				});
			}
		});
	}

	// The drag state must be scoped per seam, never keyed on the global class.
	if (fs.existsSync(STYLE)) {
		const css = fs.readFileSync(STYLE, "utf8");
		const lines = css.split(/\r?\n/);
		lines.forEach((line, index) => {
			if (/body\.gui-resizing[^{]*gui-split-grip/.test(line)) {
				violations.push({
					file: STYLE,
					line: index + 1,
					detail: "drag state keyed on body.gui-resizing — lights every seam at once",
				});
			}
		});
		if (!/\.gui-split-grip\[data-resizing\]/.test(css)) {
			violations.push({
				file: STYLE,
				line: 0,
				detail: "missing .gui-split-grip[data-resizing] (per-seam drag state)",
			});
		}
	} else {
		violations.push({ file: STYLE, line: 0, detail: "gui-settings.css missing" });
	}

	return violations;
}

const repoRoot = path.resolve(import.meta.dir, "..");
process.chdir(repoRoot);

const violations = scan();
if (violations.length === 0) {
	console.log("splitter grip: compliant");
	process.exit(0);
}
console.error("splitter grip guard failed:");
for (const v of violations) console.error(`  ${v.file}${v.line ? `:${v.line}` : ""}  ${v.detail}`);
console.error("\nSee docs/gui-components.md (SplitterGrip) for the contract.");
process.exit(1);
