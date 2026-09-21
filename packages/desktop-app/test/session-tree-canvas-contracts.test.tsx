import "./dom-shim";
import { describe, expect, it } from "bun:test";
import { t } from "@musepi/client-core";
import { renderToStaticMarkup } from "react-dom/server";
import { SessionTreeCanvas } from "../src/components/SessionTreeCanvas";

/**
 * Canvas markup contracts that a hover-only, pointer-first surface silently
 * breaks. These are markup-level assertions (no DOM interaction), which is why
 * they belong here rather than in an e2e probe: the failure mode is "the button
 * announces the wrong thing" / "the shell cannot be reached by keyboard", and
 * both are visible in the rendered tree.
 */
function render(entries: unknown[]): string {
	return renderToStaticMarkup(
		<SessionTreeCanvas entries={entries} onJump={() => {}} onSwitch={() => {}} onBranchTo={() => {}} />,
	);
}

function msg(id: string, parentId: string | null, ts: number, role = "user"): unknown {
	return {
		type: "message",
		id,
		parentId,
		timestamp: new Date(ts).toISOString(),
		message: { role, content: [{ type: "text", text: `${role} ${id}` }] },
	};
}

/** A conversation long enough to fill the map with content cards. */
function longChain(n: number): unknown[] {
	const entries: unknown[] = [msg("m0", null, 1)];
	for (let i = 1; i < n; i++) entries.push(msg(`m${i}`, `m${i - 1}`, i + 1, i % 2 === 0 ? "assistant" : "user"));
	return entries;
}

describe("SessionTreeCanvas markup contracts", () => {
	it("gives the two search-navigation actions distinct labels", () => {
		// Regression: BOTH arrows carried `trajectory clear filter`, so a screen
		// reader announced "clear filter" for "next match" too. The contract is
		// that two different actions never share one label.
		//
		// Asserted on the catalogs rather than on rendered markup: the nav
		// buttons only exist once a query is typed, and this file renders
		// statically (no DOM to type into) — an SSR assertion here would match
		// nothing and pass for the wrong reason.
		const previous = t("trajectory search previous");
		const next = t("trajectory search next");
		expect(previous).not.toBe(next);
		expect(previous).not.toBe(t("trajectory clear filter"));
		expect(next).not.toBe(t("trajectory clear filter"));
	});

	it("节点卡渲染角色标题与摘要文字,且没有链段折叠胶囊", () => {
		const html = render(longChain(120));
		// 标题来自角色词表,摘要来自条目文本——卡片不是只有时刻的窄条。
		expect(html).toContain(t("trajectory user"));
		expect(html).toContain(t("trajectory assistant"));
		expect(html).toContain("user m0");
		// 「链段折叠」是线性 transcript 的手段,地图不渲染该胶囊。
		expect(html).not.toContain("stc-fold");
	});
});
