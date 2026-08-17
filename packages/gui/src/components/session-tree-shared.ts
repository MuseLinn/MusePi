import type { GuiTreeNode } from "./SessionTree";

interface FlatNode {
	node: GuiTreeNode;
	indent: number;
	showConnector: boolean;
	isLast: boolean;
}

/**
 * Flatten a session tree for rendering, ported from the TUI TreeList
 * indentation rules (tui/tree-list.ts + modes/components/tree-selector.ts):
 * - indent 0 stays 0 unless the parent branches (>1 children → +1)
 * - indent 1 children always go to 2 (visual grouping of the subtree)
 * - indent 2+: single-child chains stay flat, +1 only when a parent branches
 * Connectors (├─/└─) show only when a node is a branched child.
 */
export function flattenTree(roots: GuiTreeNode[]): FlatNode[] {
	const result: FlatNode[] = [];
	type StackItem = [GuiTreeNode, number, boolean, boolean, boolean];
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
