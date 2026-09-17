/**
 * Project-space display names (issue #15).
 *
 * Two different folders can share a basename (`D:\a\demo` and `D:\b\demo`).
 * Identity everywhere in the GUI is the FULL path — storage, grouping keys and
 * drag/drop all use it — but the visible label was the basename alone, so two
 * distinct workspaces rendered as two identical "demo" rows and the import flow
 * merged both sets of sessions into one group.
 *
 * These helpers keep the full path as identity and only widen the LABEL when a
 * basename is actually ambiguous (`a/demo` vs `b/demo`), escalating to more
 * parent segments if the parents collide too.
 */

/** Last path segment (Windows + POSIX separators). */
export function pathBaseName(p: string): string {
	const parts = p.split(/[\\/]/).filter(Boolean);
	return parts[parts.length - 1] || p;
}

function segments(p: string): string[] {
	return p.split(/[\\/]/).filter(Boolean);
}

/**
 * Per-path display labels: the basename, widened with just enough parent
 * segments to make every label in `paths` unique. Unambiguous folders keep the
 * plain basename — this must not turn every row into a long path.
 */
export function projectLabels(paths: readonly string[]): Map<string, string> {
	// Deduplicate first: the same path listed twice is one workspace and must
	// not read as a collision (it would otherwise widen to its full path).
	const unique = [...new Set(paths)];
	const segs = new Map<string, string[]>();
	for (const p of unique) segs.set(p, segments(p));
	// Depth = how many trailing segments the label shows.
	const depth = new Map<string, number>();
	for (const p of unique) depth.set(p, 1);

	const labelOf = (p: string): string => {
		const s = segs.get(p) ?? [];
		if (s.length === 0) return p;
		const d = Math.min(depth.get(p) ?? 1, s.length);
		return s.slice(s.length - d).join("/");
	};

	// Escalate only the colliding labels; stop when nothing can widen further
	// (paths are exhausted) or every label is unique. Bounded so a pathological
	// input can never spin.
	for (let guard = 0; guard < 16; guard++) {
		const byLabel = new Map<string, string[]>();
		for (const p of unique) {
			const l = labelOf(p);
			const group = byLabel.get(l);
			if (group) group.push(p);
			else byLabel.set(l, [p]);
		}
		let widened = false;
		for (const group of byLabel.values()) {
			if (group.length < 2) continue;
			for (const p of group) {
				const s = segs.get(p) ?? [];
				const d = depth.get(p) ?? 1;
				if (d < s.length) {
					depth.set(p, d + 1);
					widened = true;
				}
			}
		}
		if (!widened) break;
	}

	const out = new Map<string, string>();
	for (const p of unique) out.set(p, labelOf(p));
	return out;
}

/** Convenience for single-row call sites that know the competing paths. */
export function projectLabel(path: string, allPaths: readonly string[]): string {
	return projectLabels(allPaths).get(path) ?? pathBaseName(path);
}
