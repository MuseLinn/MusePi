/**
 * A GUI can call board.save before any session (or extensions.list) has run.
 * The service must evaluate the extension entries once so a plugin card type
 * is in the process index, otherwise the first save rejects a valid card.
 */
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { boardsFile } from "../src/bundled-plugins/board/store";
import { rememberRegisteredWidget, resetRegisteredWidgets } from "../src/daemon/registered-widgets";
import { BoardService } from "../src/daemon/services/board-service";

const file = boardsFile();
let backup: string | null = null;

function withTempBoards(body: () => Promise<void>): Promise<void> {
	backup = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, "[]");
	return body().finally(() => {
		if (backup === null) fs.rmSync(file, { force: true });
		else fs.writeFileSync(file, backup);
		resetRegisteredWidgets();
	});
}

describe("board service plugin widget types", () => {
	afterEach(() => resetRegisteredWidgets());

	test("loads extensions before validating a save", async () => {
		await withTempBoards(async () => {
			const service = new BoardService({
				extensionRuntimeLoad: async () => {
					rememberRegisteredWidget({
						type: "probe",
						label: "Probe",
						fields: [{ key: "value", type: "number" }],
						defaults: () => ({ value: 1 }),
						moduleUrl: "./probe.tsx",
					});
				},
			});
			const result = await service.save({
				boards: [
					{
						id: "b1",
						title: "probe board",
						widgets: [{ id: "w1", type: "probe", title: "P", data: {}, pos: { x: 0, y: 0, w: 200, h: 150 } }],
					},
				],
			});
			expect(result.ok).toBe(true);
		});
	});

	test("schema includes a type registered during the load", async () => {
		const service = new BoardService({
			extensionRuntimeLoad: async () => {
				rememberRegisteredWidget({
					type: "probe",
					label: "Probe",
					fields: [],
					defaults: () => ({}),
					moduleUrl: "./probe.tsx",
				});
			},
		});
		const schema = (await service.schema()) as { types: Record<string, unknown>; tones: Record<string, string> };
		expect(schema.types.probe).toBeDefined();
		expect(schema.tones.probe).toBe("default");
	});
});
