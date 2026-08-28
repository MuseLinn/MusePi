/** Commit-graph lane solver: turns an ordered commit list (children before
 *  parents, as `git log --topo-order` yields) into per-row lane positions
 *  and connector segments for the git-panel graph rail. Pure function —
 *  the renderer maps columns to x, rows to y.
 *
 *  Model: each column is a "branch tip" slot flowing downward, holding the
 *  hash it expects the next rows to place. A commit occupies the leftmost
 *  column already expecting it (stragglers join into the node); parents
 *  continue the lane (first parent) or open/merge into other columns. */

export interface GraphCommitInput {
	hash: string;
	parents: string[];
}

/** One connector drawn in a row's band. `pass` continues straight down,
 *  `merge`/`join` are diagonals (branch out to a new lane / into an
 *  existing lane, or a stale column converging into this row's node). */
export interface GraphSegment {
	from: number;
	to: number;
	kind: "pass" | "merge" | "join";
}

export interface GraphRow {
	/** Column of this row's node dot. */
	lane: number;
	segments: GraphSegment[];
}

export interface GraphLayout {
	rows: GraphRow[];
	/** Total number of columns ever used (SVG width = lanes * COLS). */
	lanes: number;
}

export function solveGraphLanes(commits: GraphCommitInput[]): GraphLayout {
	// expected[column] = hash that column is waiting to place, or null (free).
	let expected: (string | null)[] = [];
	let lanes = 0;
	const rows: GraphRow[] = [];

	// Reuse the leftmost free slot, else grow the grid.
	const allocateIn = (cols: (string | null)[]): number => {
		const free = cols.indexOf(null);
		if (free !== -1) return free;
		cols.push(null);
		return cols.length - 1;
	};

	for (const commit of commits) {
		const parents = commit.parents.filter(p => p && p !== commit.hash);
		const inCols = expected;
		const out = [...inCols];

		let lane = inCols.indexOf(commit.hash);
		if (lane === -1) lane = allocateIn(out);

		const segments: GraphSegment[] = [];

		// Straggler columns also expecting this commit converge into the node.
		for (let c = 0; c < inCols.length; c++) {
			if (c !== lane && inCols[c] === commit.hash) {
				segments.push({ from: c, to: lane, kind: "join" });
				out[c] = null;
			}
		}

		// First parent continues the node's lane; no parents frees it.
		const first = parents[0];
		out[lane] = first ?? null;
		if (first) segments.push({ from: lane, to: lane, kind: "pass" });

		// Additional parents merge out to their lane (existing) or a new one.
		for (const parent of parents.slice(1)) {
			if (parent === first) continue;
			const existing = out.indexOf(parent);
			if (existing !== -1 && existing !== lane) {
				segments.push({ from: lane, to: existing, kind: "merge" });
			} else {
				const k = allocateIn(out);
				out[k] = parent;
				segments.push({ from: lane, to: k, kind: "merge" });
			}
		}

		// Every other still-active lane passes straight through the band.
		for (let c = 0; c < inCols.length; c++) {
			if (c !== lane && inCols[c] != null && out[c] === inCols[c]) {
				segments.push({ from: c, to: c, kind: "pass" });
			}
		}

		lanes = Math.max(lanes, out.length);
		expected = out;
		// Trim trailing free slots so allocation reuses the leftmost.
		while (expected.length > 0 && expected[expected.length - 1] === null) {
			expected.pop();
		}

		rows.push({ lane, segments });
	}

	return { rows, lanes: Math.max(lanes, expected.length, 1) };
}
