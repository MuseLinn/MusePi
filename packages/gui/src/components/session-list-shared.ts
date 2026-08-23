import type { SessionListNode } from "./SessionList";

interface FlatNode {
	node: SessionListNode;
	indent: number;
	showConnector: boolean;
	isLast: boolean;
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
 * Flatten a session tree for rendering, ported from the TUI TreeList
 * indentation rules (tui/tree-list.ts + modes/components/tree-selector.ts):
 * - indent 0 stays 0 unless the parent branches (>1 children → +1)
 * - indent 1 children always go to 2 (visual grouping of the subtree)
 * - indent 2+: single-child chains stay flat, +1 only when a parent branches
 * Connectors (├─/└─) show only when a node is a branched child.
 */
export function flattenTree(roots: SessionListNode[]): FlatNode[] {
	const result: FlatNode[] = [];
	type StackItem = [SessionListNode, number, boolean, boolean, boolean];
	const stack: StackItem[] = [];
	for (let i = roots.length - 1; i >= 0; i--) {
		const isLast = i === roots.length - 1;
		stack.push([roots[i], 0, true, roots.length > 1, isLast]);
	}
	while (stack.length > 0) {
		const [node, indent, justBranched, showConnector, isLast] = stack.pop()!;
		result.push({ node, indent, showConnector, isLast });
		const children = node.children;
		const multipleChildren = children.length > 1;
		let childIndent: number;
		if (multipleChildren) {
			childIndent = indent + 1;
		} else if (justBranched && indent > 0) {
			childIndent = indent + 1;
		} else {
			childIndent = indent;
		}
		for (let i = children.length - 1; i >= 0; i--) {
			const childIsLast = i === children.length - 1;
			stack.push([children[i], childIndent, multipleChildren, true, childIsLast]);
		}
	}
	return result;
}
