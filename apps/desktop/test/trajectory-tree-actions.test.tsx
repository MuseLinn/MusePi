import "./dom-shim";
import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { TreeNodeRow } from "../src/components/TrajectoryView";
import type { MessageTreeNode } from "../src/lib/message-tree";

/**
 * 分支树行悬停操作的 kind 分派契约。
 * 失败模式:branchAt 对 user 消息锚是"定位父级 + 回填草稿"的重答语义,
 * 对 assistant/工具锚 leaf 直接落节点(= 纯切换)。两种语义混在一个
 * 「重答」按钮下时,点在旧分支的助手消息上标着"重答"实际只是把叶切
 * 过去(不回填、不重新回答)——与地图右键菜单修掉的是同一类假操作。
 * 契约:行按 entry kind 只渲染与 branchAt 语义匹配的那一个操作。
 */

const REANSWER = /branch re-answer here|Re-answer from this branch|在此分支重新回答/;
const SWITCH = /map switch to branch|Switch to this branch|切换到此分支/;

function nodeWithRole(role: string): MessageTreeNode {
	return {
		id: `e-${role}`,
		parentId: null,
		timestamp: new Date(1000).toISOString(),
		entry: { type: "message", message: { role } },
		children: [],
	};
}

function renderRow(role: string): string {
	return renderToStaticMarkup(
		<TreeNodeRow
			node={nodeWithRole(role)}
			depth={0}
			isLeaf={false}
			onPath={true}
			childCount={0}
			isCollapsed={false}
			onToggleCollapse={() => {}}
			onJump={() => {}}
			onBranchTo={() => {}}
			onSwitchTo={() => {}}
			onForkAt={() => {}}
		/>,
	);
}

describe("分支树行悬停操作按 kind 分派", () => {
	it("user 消息行:只渲染「在此重答」,不渲染「切换到此分支」", () => {
		const html = renderRow("user");
		expect(REANSWER.test(html)).toBe(true);
		expect(SWITCH.test(html)).toBe(false);
	});

	it("assistant 消息行:只渲染「切换到此分支」,不渲染「在此重答」", () => {
		const html = renderRow("assistant");
		expect(SWITCH.test(html)).toBe(true);
		expect(REANSWER.test(html)).toBe(false);
	});

	it("工具结果行:只渲染「切换到此分支」", () => {
		const html = renderRow("toolResult");
		expect(SWITCH.test(html)).toBe(true);
		expect(REANSWER.test(html)).toBe(false);
	});
});
