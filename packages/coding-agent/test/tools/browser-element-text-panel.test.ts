import { afterEach, describe, expect, it, vi } from "bun:test";
import { runInNewContext } from "node:vm";
import { toolWireSchema, validateJsonSchemaValue } from "@musepi/pi-ai/utils/schema";
import { Settings } from "@musepi/pi-coding-agent/config/settings";
import type { ToolSession } from "@musepi/pi-coding-agent/sdk";
import { BrowserTool } from "@musepi/pi-coding-agent/tools/browser";
import { type PageTextSnapshot, pageTextCode } from "@musepi/pi-coding-agent/tools/browser/page-text";
import { createElementSnapshot } from "@musepi/pi-coding-agent/tools/browser/snapshots";
import * as supervisor from "@musepi/pi-coding-agent/tools/browser/tab-supervisor";

function makeSession(): ToolSession {
	return {
		cwd: "/tmp/test",
		hasUI: true,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
	};
}

afterEach(() => vi.restoreAllMocks());

describe("element-scoped page text", () => {
	it("accepts element reads and panel activation in the public schema", () => {
		const schema = toolWireSchema(new BrowserTool(makeSession()));
		for (const args of [
			{ action: "read", name: "docs", scope: "element", snapshotId: "elements-1", ref: "e7" },
			{ action: "activate_panel", name: "docs" },
		]) {
			expect(validateJsonSchemaValue(schema, args).success).toBe(true);
		}
	});

	it("reads only the resolved element subtree and returns its snapshot identity", async () => {
		const code = pageTextCode({ scope: "element", snapshotId: "elements-1", ref: "e7" });
		const root = {};
		const selected = { parentElement: { closest: () => null }, textContent: "Chosen subtree" };
		const sibling = { parentElement: { closest: () => null }, textContent: "Sibling must stay excluded" };
		const document = {
			body: {},
			documentElement: {},
			title: "Fixture",
			createTreeWalker(actualRoot: unknown) {
				const nodes = actualRoot === root ? [selected] : [selected, sibling];
				let index = -1;
				return {
					currentNode: nodes[0],
					nextNode() {
						index += 1;
						if (index < nodes.length) this.currentNode = nodes[index];
						return index < nodes.length;
					},
				};
			},
			createRange() {
				return {
					selectNodeContents() {},
					getBoundingClientRect: () => ({ bottom: 20, right: 100, top: 0, left: 0, width: 100, height: 20 }),
				};
			},
		};
		const tab = {
			evaluate() {
				throw new Error("element read must not evaluate the whole page");
			},
			async id(id: number) {
				expect(id).toBe(7);
				return {
					evaluate: (fn: (element: unknown, options: unknown) => unknown, options: unknown) => fn(root, options),
				};
			},
		};
		const result = (await runInNewContext(`(async () => { ${code} })()`, {
			tab,
			document,
			innerHeight: 600,
			innerWidth: 800,
			location: { href: "https://example.test/" },
			getComputedStyle: () => ({ display: "block", visibility: "visible" }),
		})) as PageTextSnapshot;

		expect(result.text).toBe("Chosen subtree");
		expect(result.text).not.toContain("Sibling must stay excluded");
		expect(result).toMatchObject({
			scope: "element",
			snapshotId: "elements-1",
			ref: "e7",
			url: "https://example.test/",
			title: "Fixture",
		});
	});

	it("requires snapshot identity and rejects refs outside that snapshot before running", async () => {
		expect(() => pageTextCode({ scope: "element", ref: "e7" })).toThrow(/snapshotId/i);
		expect(() => pageTextCode({ scope: "element", snapshotId: "elements-1" })).toThrow(/ref/i);
		const snapshot = createElementSnapshot("docs", {
			url: "https://example.test/",
			title: "Fixture",
			viewport: { width: 800, height: 600 },
			scroll: { x: 0, y: 0, width: 800, height: 600, scrollWidth: 800, scrollHeight: 600 },
			elements: [{ id: 7, role: "region", name: "Chosen", states: [] }],
		});
		const run = vi.spyOn(supervisor, "runInTab");
		await expect(
			new BrowserTool(makeSession()).execute("bad-ref", {
				action: "read",
				name: "docs",
				scope: "element",
				snapshotId: snapshot.snapshotId,
				ref: "e99",
			}),
		).rejects.toThrow(/ref/i);
		expect(run).not.toHaveBeenCalled();
	});

	it("does not treat the read-only element scope as an element snapshot scope", async () => {
		const run = vi.spyOn(supervisor, "runInTab");
		await expect(
			new BrowserTool(makeSession()).execute("invalid-elements", {
				action: "elements",
				name: "docs",
				scope: "element",
			}),
		).rejects.toThrow(/only valid for read/i);
		expect(run).not.toHaveBeenCalled();
	});
});

describe("managed panel activation", () => {
	it("reveals the panel through the managed command without activating a target", async () => {
		const send = vi.fn().mockResolvedValue({ ok: true, panelVisible: true });
		const detach = vi.fn().mockResolvedValue(undefined);
		const tab = {
			state: "alive",
			backend: "worker",
			targetId: "PAGE1",
			info: { url: "https://example.test/", title: "Fixture", targetId: "PAGE1" },
			browser: {
				kind: { kind: "connected", gui: true },
				browser: { target: () => ({ createCDPSession: async () => ({ send, detach }) }) },
			},
		};
		vi.spyOn(supervisor, "getTab").mockReturnValue(tab as never);
		const activateTarget = vi.spyOn(supervisor, "activateTabTarget");

		const result = await new BrowserTool(makeSession()).execute("panel", { action: "activate_panel", name: "docs" });

		expect(send).toHaveBeenCalledWith("ManagedBrowser.activatePanel");
		expect(detach).toHaveBeenCalled();
		expect(activateTarget).not.toHaveBeenCalled();
		expect(result.details?.control).toEqual({ action: "activate_panel", panelVisible: true });
	});
});
