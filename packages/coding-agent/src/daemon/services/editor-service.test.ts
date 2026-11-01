import { describe, expect, it } from "bun:test";
import type { Diagnostic, LspClient } from "../../lsp/types";
import { EditorService, type EditorServiceDeps } from "./editor-service";

const client = { name: "test-language-server" } as LspClient;
const diagnostic: Diagnostic = {
	range: { start: { line: 0, character: 1 }, end: { line: 0, character: 4 } },
	severity: 2,
	message: "example warning",
};

function deps(overrides: Partial<EditorServiceDeps> = {}): EditorServiceDeps {
	return {
		resolveClient: async () => client,
		sync: async () => {},
		saved: async () => {},
		diagnostics: async () => [],
		request: async () => null,
		...overrides,
	};
}

describe("EditorService", () => {
	it("degrades without spawning or syncing when no server matches the file", async () => {
		let syncs = 0;
		const service = new EditorService(
			deps({
				resolveClient: async () => null,
				sync: async () => {
					syncs += 1;
				},
			}),
		);
		expect(await service.sync({ cwd: "/workspace", path: "/workspace/a.ts", content: "const a = 1" })).toEqual({
			available: false,
			diagnostics: [],
		});
		expect(syncs).toBe(0);
	});

	it("synchronizes the in-memory buffer and returns raw LSP diagnostics", async () => {
		const calls: Array<{ path: string; content: string }> = [];
		const service = new EditorService(
			deps({
				sync: async (_client, path, content) => {
					calls.push({ path, content });
				},
				diagnostics: async () => [diagnostic],
			}),
		);
		const result = await service.sync({ cwd: "/workspace", path: "/workspace/a.ts", content: "const a =" });
		expect(calls).toEqual([{ path: "/workspace/a.ts", content: "const a =" }]);
		expect(result).toEqual({ available: true, diagnostics: [diagnostic] });
	});

	it("uses zero-based LSP positions and synchronizes before a hover request", async () => {
		const events: string[] = [];
		let requestParams: unknown;
		const service = new EditorService(
			deps({
				sync: async () => {
					events.push("sync");
				},
				request: async (_client, method, params) => {
					events.push(method);
					requestParams = params;
					return { contents: { kind: "plaintext", value: "const a: number" } };
				},
			}),
		);
		const result = await service.hover({
			cwd: "/workspace",
			path: "/workspace/a.ts",
			content: "const a = 1",
			line: 2,
			character: 4,
		});
		expect(events).toEqual(["sync", "textDocument/hover"]);
		expect(requestParams).toMatchObject({ position: { line: 2, character: 4 } });
		expect(result).toEqual({
			available: true,
			result: { contents: { kind: "plaintext", value: "const a: number" } },
		});
	});

	it.each([
		["implementation", "textDocument/implementation"],
		["typeDefinition", "textDocument/typeDefinition"],
	] as const)("synchronizes before %s and preserves the LSP position", async (method, lspMethod) => {
		const events: string[] = [];
		let requestParams: unknown;
		const service = new EditorService(
			deps({
				sync: async () => {
					events.push("sync");
				},
				request: async (_client, requestMethod, params) => {
					events.push(requestMethod);
					requestParams = params;
					return [];
				},
			}),
		);
		const result = await service[method]({
			cwd: "/workspace",
			path: "/workspace/a.ts",
			content: "const a = 1",
			line: 2,
			character: 4,
		});
		expect(events).toEqual(["sync", lspMethod]);
		expect(requestParams).toMatchObject({ position: { line: 2, character: 4 } });
		expect(result).toEqual({ available: true, result: [] });
	});

	it("synchronizes before references and preserves the declaration filter", async () => {
		const events: string[] = [];
		let requestParams: unknown;
		const service = new EditorService(
			deps({
				sync: async () => {
					events.push("sync");
				},
				request: async (_client, method, params) => {
					events.push(method);
					requestParams = params;
					return [];
				},
			}),
		);
		const result = await service.references({
			cwd: "/workspace",
			path: "/workspace/a.ts",
			content: "const a = 1",
			line: 2,
			character: 4,
			includeDeclaration: false,
		});
		expect(events).toEqual(["sync", "textDocument/references"]);
		expect(requestParams).toMatchObject({
			position: { line: 2, character: 4 },
			context: { includeDeclaration: false },
		});
		expect(result).toEqual({ available: true, result: [] });
	});

	it("synchronizes before rename and sends the requested symbol name", async () => {
		const events: string[] = [];
		let requestParams: unknown;
		const workspaceEdit = { changes: { "file:///workspace/a.ts": [] } };
		const service = new EditorService(
			deps({
				sync: async () => {
					events.push("sync");
				},
				request: async (_client, method, params) => {
					events.push(method);
					requestParams = params;
					return workspaceEdit;
				},
			}),
		);
		const params = {
			cwd: "/workspace",
			path: "/workspace/a.ts",
			content: "const alpha = 1",
			line: 0,
			character: 7,
			newName: "beta",
		};
		expect(await service.rename(params)).toEqual({ available: true, result: workspaceEdit });
		expect(events).toEqual(["sync", "textDocument/rename"]);
		expect(requestParams).toMatchObject({ position: { line: 0, character: 7 }, newName: "beta" });

		expect(await service.rename({ ...params, newName: "  " })).toEqual({ available: false, result: null });
		expect(events).toEqual(["sync", "textDocument/rename"]);
	});
});
