import { describe, expect, it } from "bun:test";
import { collectTurnPresented } from "./turn-presented.js";

describe("collectTurnPresented", () => {
	it("collects successful present results and keeps the last duplicate description", () => {
		const blocks = [
			{ type: "text", text: "working" },
			{ type: "toolCall", id: "a", name: "present", arguments: { files: [] } },
			{ type: "toolCall", id: "b", name: "present", arguments: { files: [] } },
			{ type: "toolCall", id: "c", name: "write", arguments: { file_path: "x" } },
		];
		const results = new Map([
			["a", { details: { files: [{ path: "/w/a.md", description: "First" }, { path: "/w/b.md" }] } }],
			["b", { details: { files: [{ path: "/w/a.md", description: "Updated" }] } }],
		]);
		expect(collectTurnPresented(blocks, id => results.get(id))).toEqual([
			{ path: "/w/a.md", description: "Updated" },
			{ path: "/w/b.md" },
		]);
	});

	it("ignores failed results and non-present tools", () => {
		const blocks = [
			{ type: "toolCall", id: "a", name: "present", arguments: { files: [{ path: "/w/a.md" }] } },
			{ type: "toolCall", id: "b", name: "write", arguments: { file_path: "/w/b.md" } },
		];
		const results = new Map([["a", { isError: true, details: { files: [{ path: "/w/a.md" }] } }]]);
		expect(collectTurnPresented(blocks, id => results.get(id))).toEqual([]);
	});
});
