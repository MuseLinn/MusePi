import { matchesFuzzyQuery } from "../lib/fuzzy-model-match";
import type { SessionListNode } from "./SessionList";

interface FlatNode {
	node: SessionListNode;
	indent: number;
}

/** Sort key for one session — last-activity (updatedAt) with a createdAt
 *  fallback for daemons that predate the field, and a stable id tiebreak.
 *  Invalid/absent timestamps sort as oldest (0) so they never jump ahead. */
export function sessionSortKey(n: SessionListNode): number {
	const updated = n.entry.updatedAt ? Date.parse(n.entry.updatedAt) : Number.NaN;
	const ts = Number.isFinite(updated) ? updated : n.entry.timestamp ? Date.parse(n.entry.timestamp) : Number.NaN;
	return Number.isFinite(ts) ? ts : 0;
}

/**
 * Hierarchically sort a session tree WITHOUT flattening it: each sibling
 * group (roots, and each node's children) is ordered by last-activity time,
 * but a forked child always stays inside its parent's subtree. This is what
 * a flat `Array.prototype.sort` over `flattenTree` output cannot do — that
 * scatters children across the whole list and reshuffles on every poll.
 * Returns a NEW tree; the input is not mutated.
 */
export function sortSessionTree(
	roots: SessionListNode[],
	compare: (a: SessionListNode, b: SessionListNode) => number,
): SessionListNode[] {
	const sortGroup = (group: SessionListNode[]): SessionListNode[] => {
		const sorted = group.map(n => ({ ...n, children: sortGroup(n.children) }));
		sorted.sort(compare);
		return sorted;
	};
	return sortGroup(roots);
}

/**
 * Flatten a session tree for rendering. Two indentation dialects:
 * - `compactSingleChildChains: true` — the TUI TreeList rules ported for the
 *   fork tree (tui/tree-list.ts + modes/components/tree-selector.ts):
 *   indent 0 stays 0 unless the parent branches (>1 children → +1); indent 1
 *   children always go to 2; indent 2+ single-child chains stay flat, +1 only
 *   when a parent branches.
 * - default (GUI sidebar) — openchamber 文件夹层级 parity: EVERY child
 *   indents one level, so a session with a single subagent still reads as a
 *   nested subtree instead of a flat sibling.
 * Hierarchy is expressed by indentation alone; no connector glyphs.
 */
export function flattenTree(roots: SessionListNode[], opts?: { compactSingleChildChains?: boolean }): FlatNode[] {
	const result: FlatNode[] = [];
	const compact = opts?.compactSingleChildChains === true;
	type StackItem = [SessionListNode, number, boolean];
	const items: StackItem[] = [];
	for (let i = roots.length - 1; i >= 0; i--) {
		items.push([roots[i], 0, true]);
	}
	while (items.length > 0) {
		const [node, indent, justBranched] = items.pop()!;
		result.push({ node, indent });
		const children = node.children;
		const multipleChildren = children.length > 1;
		let childIndent: number;
		if (children.length === 0) {
			childIndent = indent;
		} else if (!compact || multipleChildren || (justBranched && indent > 0)) {
			childIndent = indent + 1;
		} else {
			childIndent = indent;
		}
		for (let i = children.length - 1; i >= 0; i--) {
			items.push([children[i], childIndent, multipleChildren]);
		}
	}
	return result;
}

/**
 * Filter a session tree by free text matched against each node's searchable
 * text (label + cwd, fuzzy subsequence — TUI /switch parity). A node survives
 * when it matches itself or any descendant does, so a matched session stays
 * reachable inside its subtree. `matched` counts only the sessions that matched
 * on their own: the number the search box reports, and the count the filtered
 * list is built around. An empty query returns the input list untouched.
 */
export function filterSessionTree(
	roots: SessionListNode[],
	query: string,
	textOf: (node: SessionListNode) => string,
): { nodes: SessionListNode[]; matched: number } {
	const q = query.trim();
	if (!q) return { nodes: roots, matched: 0 };
	let matched = 0;
	const walk = (node: SessionListNode): SessionListNode | null => {
		const children = node.children.map(walk).filter((child): child is SessionListNode => child !== null);
		const hit = matchesFuzzyQuery(q, textOf(node));
		if (hit) matched += 1;
		return hit || children.length > 0 ? { ...node, children } : null;
	};
	const nodes = roots.map(walk).filter((node): node is SessionListNode => node !== null);
	return { nodes, matched };
}
