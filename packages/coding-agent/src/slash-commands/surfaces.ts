/**
 * Surface availability for builtin slash commands.
 *
 * Each surface owns its own catalog: the TUI dispatches the interactive
 * registry, ACP advertises the text-mode commands its client can send, and the
 * GUI asks `commands.list` for its own slice. A command declares `surfaces`
 * when its handler alone would tell the wrong story — a TUI dashboard the GUI
 * re-implements as a panel, or a terminal-only action the GUI manages through
 * its own page. Without an explicit declaration the handlers are the truth:
 * a TUI handler serves `tui`, a text-mode `handle` serves `acp` and `gui`.
 */
import type { BuiltinSlashCommand, SlashCommandSurface } from "./types";

/** The command shape the derivation reads (specs add the handlers). */
export interface SurfaceBearingCommand extends Pick<BuiltinSlashCommand, "surfaces"> {
	handle?: unknown;
	handleTui?: unknown;
}

/** Surfaces a command is offered on: explicit declaration, else its handlers. */
export function commandSurfaces(command: SurfaceBearingCommand): readonly SlashCommandSurface[] {
	if (command.surfaces !== undefined) return command.surfaces;
	const surfaces: SlashCommandSurface[] = [];
	if (command.handleTui !== undefined) surfaces.push("tui");
	if (command.handle !== undefined) surfaces.push("acp", "gui");
	return surfaces;
}

export function servesSurface(command: SurfaceBearingCommand, surface: SlashCommandSurface): boolean {
	return commandSurfaces(command).includes(surface);
}
