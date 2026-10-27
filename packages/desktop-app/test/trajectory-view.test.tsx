import "./happy-dom-shim";
import { afterEach, describe, expect, it } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { TimelineOverview } from "../src/components/TimelineOverview";
import { TrajectoryView, TreeNodeRow } from "../src/components/TrajectoryView";
import { buildTrajectoryTree } from "../src/components/trajectory-data";
import type { MessageTreeNode } from "../src/lib/message-tree";

const roots = new Set<Root>();
afterEach(async () => {
	for (const root of roots) await act(async () => root.unmount());
	roots.clear();
	document.body.innerHTML = "";
});

function msg(id: string, parentId: string | null, role: string, text: string, second: number): unknown {
	return {
		type: "message",
		id,
		parentId,
		timestamp: new Date(second * 1000).toISOString(),
		message: { role, content: [{ type: "text", text }] },
	};
}

const older = [msg("u1", null, "user", "one", 1), msg("a1", "u1", "assistant", "first", 2)];
const tail = [msg("u2", "a1", "user", "two", 3), msg("a2", "u2", "assistant", "second", 4)];

async function mount(element: React.ReactNode): Promise<{ container: HTMLElement; root: Root }> {
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	roots.add(root);
	await act(async () => root.render(element));
	return { container, root };
}

describe("trajectory history-window state", () => {
	it("keeps the same turn collapsed after older history is prepended", async () => {
		const { container, root } = await mount(<TrajectoryView entries={tail} />);
		await act(async () => container.querySelector<HTMLButtonElement>(".traj-turn-head")?.click());
		expect(container.querySelector(".traj-turn-events")).toBeNull();

		await act(async () => root.render(<TrajectoryView entries={tail} fullEntries={[...older, ...tail]} />));
		const groups = [...container.querySelectorAll<HTMLElement>(".traj-turn-group")];
		expect(groups[0]?.textContent).toContain("first");
		expect(groups[0]?.querySelector(".traj-turn-events")).not.toBeNull();
		expect(groups[1]?.textContent).toContain("second");
		expect(groups[1]?.querySelector(".traj-turn-events")).toBeNull();
	});

	it("selects an event with the keyboard and shows its inspector", async () => {
		const { container } = await mount(<TrajectoryView entries={tail} />);
		const row = container.querySelector<HTMLElement>(".traj-row");
		expect(row?.getAttribute("role")).toBe("button");
		await act(async () =>
			row?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })),
		);
		expect(container.querySelector(".traj-inspector")?.textContent).toContain("two");
	});

	it("shows paging status and terminal failure with entries already present", async () => {
		const { container, root } = await mount(<TrajectoryView entries={tail} fullEntries={tail} fullLoading />);
		expect(container.querySelector(".traj-loading-note")?.textContent).toContain("Loading older history");

		await act(async () => root.render(<TrajectoryView entries={tail} fullEntries={tail} fullError />));
		const error = container.querySelector(".traj-error-note");
		expect(error?.textContent).toContain("Older history is unavailable");
		expect(error?.tagName).toBe("DIV");
	});
});

describe("trajectory keyboard controls", () => {
	it("exposes overview turn segments as keyboard buttons", () => {
		const turns = buildTrajectoryTree([...older, ...tail]).turns;
		const html = renderToStaticMarkup(
			<TimelineOverview turns={turns} selection={null} onSelectionChange={() => {}} />,
		);
		expect(html.match(/class="traj-ov-segment" role="button" tabindex="0"/g)).toHaveLength(2);
	});

	it("renders branch collapse as a real button outside the jump button", () => {
		const node: MessageTreeNode = {
			id: "u1",
			parentId: null,
			timestamp: new Date(1000).toISOString(),
			entry: older[0],
			children: [],
		};
		const html = renderToStaticMarkup(
			<TreeNodeRow
				node={node}
				depth={0}
				isLeaf={false}
				onPath
				childCount={2}
				isCollapsed={false}
				onToggleCollapse={() => {}}
				onJump={() => {}}
			/>,
		);
		expect(html).toContain('<button type="button" class="traj-trow-badge"');
		expect(html).not.toContain("button button");
	});
});
