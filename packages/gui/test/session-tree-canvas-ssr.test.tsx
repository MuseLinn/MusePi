import "./dom-shim";
import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SessionTreeCanvas } from "../src/components/SessionTreeCanvas";

// 地图组件 SSR 冒烟:按轮分组的树能渲染出节点卡片,不抛错。
// (交互是 DOM 事件层,SSR 验证渲染契约——节点/折叠胶囊/缩放控件存在。)

function msg(id: string, parentId: string | null, ts = 1, role = "user"): unknown {
	return {
		type: "message",
		id,
		parentId,
		timestamp: new Date(ts).toISOString(),
		message: { role },
	};
}

function roundEntries(n: number): unknown[] {
	const entries: unknown[] = [];
	let prev: string | null = null;
	for (let i = 0; i < n; i++) {
		const uid = `u${i}`;
		entries.push(msg(uid, prev, i * 2 + 1, "user"));
		const aid = `a${i}`;
		entries.push(msg(aid, uid, i * 2 + 2, "assistant"));
		prev = aid;
	}
	return entries;
}

describe("SessionTreeCanvas SSR 冒烟", () => {
	it("短会话(2 轮)渲染出全部节点卡片", () => {
		const html = renderToStaticMarkup(
			<SessionTreeCanvas entries={roundEntries(2)} activePathIds={new Set()} onJump={() => {}} />,
		);
		expect(html).toContain("stc-node");
		expect(html).toContain("stc-zoom");
	});

	it("长会话(60 轮)渲染出折叠胶囊,不抛错", () => {
		const html = renderToStaticMarkup(
			<SessionTreeCanvas entries={roundEntries(60)} activePathIds={new Set()} onJump={() => {}} />,
		);
		// 长链折叠 → 出现胶囊(stc-fold)。
		expect(html).toContain("stc-fold");
		// 普通节点仍在(段首/未折叠部分)。
		expect(html).toContain("stc-node");
	});

	it("空会话渲染空态", () => {
		const html = renderToStaticMarkup(
			<SessionTreeCanvas entries={[]} activePathIds={new Set()} onJump={() => {}} />,
		);
		expect(html).toContain("stc-empty");
	});
});
