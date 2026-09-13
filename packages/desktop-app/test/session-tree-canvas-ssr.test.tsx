import "./dom-shim";
import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SessionTreeCanvas } from "../src/components/SessionTreeCanvas";

// 地图组件 SSR 冒烟:按轮分组的树能渲染出节点卡片,不抛错。
// (交互是 DOM 事件层,SSR 验证渲染契约——内容卡片/缩放控件存在。)

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
		// 卡片 = 标题行 + 摘要行(不是只有时刻的窄条)。
		expect(html).toContain("stc-node-title");
		expect(html).toContain("stc-node-text");
	});

	it("长会话(60 轮)每个条目都是内容卡片,没有链段折叠胶囊", () => {
		const html = renderToStaticMarkup(
			<SessionTreeCanvas entries={roundEntries(60)} activePathIds={new Set()} onJump={() => {}} />,
		);
		// 地图不折叠:120 个条目全部渲染成卡片。
		expect(html.split("stc-node-head").length - 1).toBe(120);
		// 「链段折叠」是线性 transcript 的手段,地图不渲染该胶囊。
		expect(html).not.toContain("stc-fold");
	});

	it("空会话渲染空态", () => {
		const html = renderToStaticMarkup(<SessionTreeCanvas entries={[]} activePathIds={new Set()} onJump={() => {}} />);
		expect(html).toContain("stc-empty");
	});
});
