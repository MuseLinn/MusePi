import { beforeAll, describe, expect, it } from "bun:test";
import { TreeSelectorComponent } from "@musepi/pi-coding-agent/modes/components/tree-selector";
import * as themeModule from "@musepi/pi-coding-agent/modes/theme/theme";
import type { SessionEntry, SessionTreeNode } from "@musepi/pi-coding-agent/session/session-entries";

let counter = 0;
function makeNode(message: Record<string, unknown>, parentId: string | null = null, timestamp = Date.now()): SessionTreeNode {
	const id = `entry-${counter++}`;
	const entry: SessionEntry = {
		type: "message",
		id,
		parentId,
		timestamp: new Date(timestamp).toISOString(),
		message,
	} as unknown as SessionEntry;
	return { entry, children: [], label: undefined };
}

function render(
	tree: SessionTreeNode[],
	projection: "tree" | "trace" = "tree",
	width = 120,
): string {
	const leaf = tree[tree.length - 1]?.entry.id ?? null;
	const selector = new TreeSelectorComponent(
		tree,
		leaf,
		60,
		() => {},
		() => {},
		undefined,
		"default",
		projection,
	);
	return Bun.stripANSI(selector.render(width).join("\n"));
}

describe("TreeSelectorComponent /trace trajectory projection", () => {
	beforeAll(async () => {
		await themeModule.initTheme(false, undefined, undefined, "dark", "light");
	});

	it("renders the trace title and keeps /tree pure-structure", () => {
		const root = makeNode({ role: "user", content: "run the bug", timestamp: 1 });
		const reply = makeNode(
			{
				role: "assistant",
				content: [{ type: "text", text: "fixed" }],
				timestamp: 2,
				usage: {
				input: 100,
				output: 50,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 150,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
				duration: 900,
				stopReason: "stop",
			},
			root.entry.id,
			2,
		);
		root.children.push(reply);

		const traceRendered = render([root], "trace");
		expect(traceRendered).toContain("Session Trace");

		const treeRendered = render([root], "tree");
		expect(treeRendered).toContain("Session Tree");
		// /tree is the pure structural projection; no token/duration columns.
		expect(treeRendered).not.toContain("14.4k↑");
		expect(treeRendered).not.toContain("8.5s");
	});

	it("overlays token in/out, duration and clock columns from the message data", () => {
		const root = makeNode({ role: "user", content: "question", timestamp: 1 });
		const reply = makeNode(
			{
				role: "assistant",
				content: [{ type: "text", text: "answer" }],
				timestamp: Date.parse("2026-08-21T10:02:31Z"),
				usage: { input: 12_400, output: 3_100, cacheRead: 0, cacheWrite: 2_000, totalTokens: 15_500, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				duration: 8_500,
				stopReason: "stop",
			},
			root.entry.id,
			Date.parse("2026-08-21T10:02:31Z"),
		);
		root.children.push(reply);

		const rendered = render([root], "trace");
		// input + cacheWrite = 14400 -> 14.4k↑ ; output = 3100 -> 3.1k↓
		expect(rendered).toContain("14.4k↑");
		expect(rendered).toContain("3.1k↓");
		expect(rendered).toContain("8.5s");
		// User root also gets a trace time column (burst-level clock).
		expect(rendered).toContain("10:02:31");
	});

	it("marks an errored assistant turn with the status symbol", () => {
		const root = makeNode({ role: "user", content: "break", timestamp: 1 });
		const failed = makeNode(
			{
				role: "assistant",
				content: [],
				timestamp: 2,
				usage: { input: 1_000, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 1_000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				duration: 1_200,
				stopReason: "error",
				errorMessage: "overloaded_error",
			},
			root.entry.id,
			2,
		);
		root.children.push(failed);

		const rendered = render([root], "trace");
		expect(rendered).toContain(themeModule.theme.status.error);
	});
});
