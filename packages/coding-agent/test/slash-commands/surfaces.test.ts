/**
 * Surface contract: a slash command's availability is declared (or derived
 * from its handlers), and each surface gets its own catalog. The TUI dashboard
 * command must not be advertised to the GUI or ACP, while a GUI-panel command
 * may be offered on both terminal and client.
 */
import { describe, expect, test } from "bun:test";
import { ACP_BUILTIN_SLASH_COMMANDS } from "@musepi/pi-coding-agent/slash-commands/acp-builtins";
import { lookupBuiltinSlashCommand } from "@musepi/pi-coding-agent/slash-commands/builtin-registry";
import { commandSurfaces, servesSurface } from "@musepi/pi-coding-agent/slash-commands/surfaces";

const surfacesOf = (name: string): readonly string[] => {
	const command = lookupBuiltinSlashCommand(name);
	expect(command).toBeDefined();
	return commandSurfaces(command!);
};

describe("slash command surfaces", () => {
	test("a TUI dashboard command declares the terminal only", () => {
		expect(surfacesOf("extensions")).toEqual(["tui"]);
		expect(servesSurface(lookupBuiltinSlashCommand("extensions")!, "gui")).toBe(false);
	});

	test("a GUI-panel command declares both terminal and client", () => {
		expect(surfacesOf("debug")).toEqual(["tui", "gui"]);
		expect(servesSurface(lookupBuiltinSlashCommand("debug")!, "acp")).toBe(false);
	});

	test("a text-mode command derives acp and gui from its handler", () => {
		const compact = lookupBuiltinSlashCommand("compact")!;
		expect(commandSurfaces(compact)).toEqual(["tui", "acp", "gui"]);
	});

	test("the ACP catalog follows the acp surface, not handler presence", () => {
		const names = ACP_BUILTIN_SLASH_COMMANDS.map(command => command.name);
		expect(names).not.toContain("extensions");
		expect(names).toContain("compact");
	});
});
