/**
 * Terminal state collection for the debug menu.
 *
 * Surfaces the detected terminal capabilities negotiated by the renderer.
 */
import { getCapabilities, getCellDimensions } from "@musepi/pi-tui";

export interface TerminalRuntimeState {
	columns: number;
	rows: number;
}

export interface TerminalStateInfo {
	detectedId: string;
	columns: number;
	rows: number;
	cellWidthPx: number;
	cellHeightPx: number;
	trueColor: boolean;
	imageProtocol: string;
	hyperlinks: boolean;
	env: { TERM?: string; TERM_PROGRAM?: string; TERM_PROGRAM_VERSION?: string; COLORTERM?: string };
}

const IMAGE_PROTOCOL_NAMES: Record<string, string> = {
	none: "none",
	kitty: "Kitty",
	iterm2: "iTerm2",
	sixel: "Sixel",
};

/** Snapshot the active terminal capabilities and the live geometry. */
export function collectTerminalState(runtime: TerminalRuntimeState): TerminalStateInfo {
	const caps = getCapabilities();
	const cell = getCellDimensions();

	// Map ImageProtocol (which could be string or number enum) to display name
	const imageProtocol = IMAGE_PROTOCOL_NAMES[String(caps.images)] ?? String(caps.images);

	return {
		detectedId: "",
		columns: runtime.columns,
		rows: runtime.rows,
		cellWidthPx: cell.widthPx,
		cellHeightPx: cell.heightPx,
		trueColor: caps.trueColor,
		imageProtocol,
		hyperlinks: caps.hyperlinks,
		env: {
			TERM: process.env.TERM,
			TERM_PROGRAM: process.env.TERM_PROGRAM,
			TERM_PROGRAM_VERSION: process.env.TERM_PROGRAM_VERSION,
			COLORTERM: process.env.COLORTERM,
		},
	};
}

const yesNo = (value: boolean): string => (value ? "yes" : "no");

/** Format terminal state for display in the debug menu. */
export function formatTerminalState(info: TerminalStateInfo): string {
	return [
		`Detected ID:       ${info.detectedId || "N/A"}`,
		`Columns:           ${info.columns}`,
		`Rows:              ${info.rows}`,
		`Cell size:         ${info.cellWidthPx}×${info.cellHeightPx}px`,
		`True color:        ${yesNo(info.trueColor)}`,
		`Image protocol:    ${info.imageProtocol}`,
		`Hyperlinks:        ${yesNo(info.hyperlinks)}`,
		``,
		`TERM:              ${info.env.TERM ?? "—"}`,
		`TERM_PROGRAM:      ${info.env.TERM_PROGRAM ?? "—"}`,
		`TERM_PROGRAM_VER:  ${info.env.TERM_PROGRAM_VERSION ?? "—"}`,
		`COLORTERM:         ${info.env.COLORTERM ?? "—"}`,
	].join("\n");
}
