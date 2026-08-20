import { describe, expect, test } from "bun:test";
import { detectLineCommands } from "../../../packages/gui/src/components/composer/slash-command-tip";

describe("detectLineCommands (slash badge)", () => {
	const known = new Set(["queue", "pause", "model", "usage", "context", "compact"]);

	test("line-leading known command is detected", () => {
		expect(detectLineCommands("/queue hi there", known)).toEqual(["queue"]);
	});

	test("mid-line slashes are NOT commands (string input)", () => {
		expect(detectLineCommands("type /queue in the chat", known)).toEqual([]);
		expect(detectLineCommands("path is /usr/local/queue", known)).toEqual([]);
	});

	test("unknown command names render nothing", () => {
		expect(detectLineCommands("/nosuchcommand foo", known)).toEqual([]);
	});

	test("escaped double-slash is literal text", () => {
		expect(detectLineCommands("//queue not a command", known)).toEqual([]);
	});

	test("bare slash is not a command", () => {
		expect(detectLineCommands("/", known)).toEqual([]);
	});

	test("multi-line draft: one badge per line-leading command, deduped", () => {
		expect(detectLineCommands("/queue one\n/pause two\n/queue three", known)).toEqual(["queue", "pause"]);
	});

	test("second line leading command is detected", () => {
		expect(detectLineCommands("some prose\n/model step-3.7", known)).toEqual(["model"]);
	});

	test("command with args and trailing slash text", () => {
		expect(detectLineCommands("/compact --hard", known)).toEqual(["compact"]);
	});
});
