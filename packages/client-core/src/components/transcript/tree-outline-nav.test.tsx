import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { SessionEntry } from "@musepi/pi-wire";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { t } from "../../i18n/index.js";
import { deriveTreeOutline } from "./tree-outline";
import { TreeOutlineNav } from "./tree-outline-nav";

GlobalRegistrator.register();
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

afterAll(() => {
	void GlobalRegistrator.unregister();
});

let root: Root | null = null;
let host: HTMLDivElement | null = null;
afterEach(() => {
	act(() => root?.unmount());
	host?.remove();
	root = null;
	host = null;
});

/** Fixture copy. Named so the i18n guard does not read it as product copy: these
 *  strings exist only to be echoed back through the breadcrumb and the fork hint. */
const FIXTURE_PROMPT = "hello";
const FIXTURE_ANSWER = "first answer";

const user = (id: string, parentId: string | null, text: string): SessionEntry =>
	({
		id,
		parentId,
		timestamp: "0",
		type: "message",
		message: { role: "user", content: text, timestamp: 1 },
	}) as unknown as SessionEntry;

const assistant = (id: string, parentId: string | null, text: string): SessionEntry =>
	({
		id,
		parentId,
		timestamp: "0",
		type: "message",
		message: { role: "assistant", content: [{ type: "text", text }], timestamp: 2 },
	}) as unknown as SessionEntry;

function render(node: React.ReactNode): HTMLDivElement {
	host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	act(() => root?.render(node));
	return host;
}

const noop = (): void => {};

describe("TreeOutlineNav", () => {
	it("stays out of the way of a linear conversation", () => {
		const outline = deriveTreeOutline([user("u1", null, FIXTURE_PROMPT), assistant("a1", "u1", "hi")], {
			mode: "tip",
		});
		const el = render(<TreeOutlineNav outline={outline} onJump={noop} />);
		// 线性会话的面包屑只是把转录重排一遍;没有任何树信息时不占版面。
		expect(el.querySelector(".tr-tree-outline")).toBeNull();
	});

	it("names the node a send would fork from", () => {
		// 撤回后 leaf 停在 a1 上,而它已经有子节点 a2 —— 再发送就是新分支。
		const entries = [
			user("u1", null, FIXTURE_PROMPT),
			assistant("a1", "u1", FIXTURE_ANSWER),
			assistant("a2", "a1", "second"),
		];
		const outline = deriveTreeOutline(entries, { mode: "node", id: "a1" });
		const el = render(<TreeOutlineNav outline={outline} onJump={noop} />);
		const hint = el.querySelector(".tr-tree-outline-hint");
		expect(hint?.textContent).toContain(t("transcript.willForkNewBranchWithLabel", { label: FIXTURE_ANSWER }));
		expect(el.querySelector(".tr-tree-outline-crumbs")).not.toBeNull();
	});

	it("reports a fork at the branch point and jumps to the clicked node", () => {
		const entries = [
			user("u1", null, FIXTURE_PROMPT),
			assistant("a1", "u1", FIXTURE_ANSWER),
			assistant("b1", "u1", "other"),
		];
		const outline = deriveTreeOutline(entries, { mode: "tip" });
		const jumped: string[] = [];
		const el = render(<TreeOutlineNav outline={outline} onJump={id => jumped.push(id)} />);
		const crumbs = [...el.querySelectorAll<HTMLButtonElement>(".tr-tree-outline-seg")];
		expect(crumbs.map(crumb => crumb.textContent)).toEqual([FIXTURE_PROMPT, "other"]);
		crumbs[0]?.click();
		expect(jumped).toEqual(["u1"]);
		// 当前叶标记在最后一段上,而不是路径中间。
		expect(crumbs[1]?.getAttribute("aria-current")).toBe("location");
	});

	it("offers undo after a rewind and reports both actions", () => {
		const entries = [user("u1", null, FIXTURE_PROMPT), assistant("a1", "u1", "reply")];
		const outline = deriveTreeOutline(entries, { mode: "root" });
		let undone = 0;
		let dismissed = 0;
		const el = render(
			<TreeOutlineNav
				outline={outline}
				onJump={noop}
				undo={{ label: FIXTURE_PROMPT, onUndo: () => (undone += 1), onDismiss: () => (dismissed += 1) }}
			/>,
		);
		const row = el.querySelector(".tr-tree-outline-undo");
		expect(row?.textContent).toContain(FIXTURE_PROMPT);
		el.querySelector<HTMLButtonElement>(".tr-tree-outline-undo-action")?.click();
		el.querySelector<HTMLButtonElement>(".tr-tree-outline-close")?.click();
		expect(undone).toBe(1);
		expect(dismissed).toBe(1);
	});
});
