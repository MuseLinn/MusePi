// ============================================================
// MusePi boxed editor — the Kimi Code-style closed box (╭╮│╰╯) as
// the fork's native input editor (no extension host).
//
//   boxed   — closed box; top border carries spinner + working state
//             left, model name right (settings.modelInBorder).
//   compact — side-less; top border carries the same slots on a plain
//             dash row.
//   plain   — not handled here: interactive-mode falls back to pi's
//             CustomEditor.
//
// Chrome state is read lazily per render through the slots callbacks,
// so no event wiring is needed: streaming ticks re-render anyway, and
// the border spinner advances with them.
// ============================================================

import type { EditorTheme, TUI } from "@earendil-works/pi-tui";
import { composeTopBorder, type EditorStyle, wrapWithSideBorders } from "@musepi/core/tui/box.js";

import type { KeybindingsManager } from "../../core/keybindings.ts";
import { CustomEditor } from "../../modes/interactive/components/custom-editor.ts";

/** Pre-styled border slots, evaluated per render (cheap string joins). */
export interface EditorSlots {
	left(): string;
	right(): string;
}

export class MusepiBoxedEditor extends CustomEditor {
	private readonly chromeStyle: EditorStyle;
	private readonly slots: EditorSlots;

	constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager, style: EditorStyle, slots: EditorSlots) {
		// boxed needs column 0 reserved for the left │ bar (pi-tui pads rows
		// with spaces up to paddingX; wrapWithSideBorders overlays them).
		super(tui, theme, keybindings, { paddingX: style === "boxed" ? 1 : 0 });
		this.chromeStyle = style;
		this.slots = slots;
	}

	/**
	 * pi copies the default editor's paddingX into custom editors right
	 * after construction (setCustomEditorComponent). Enforce the boxed
	 * minimum here so the side bars always have a space column to land on.
	 */
	override setPaddingX(padding: number): void {
		super.setPaddingX(this.chromeStyle === "boxed" ? Math.max(1, padding) : padding);
	}

	override render(width: number): string[] {
		const lines = super.render(width);
		if (lines.length === 0) return lines;
		const paint = (s: string) => this.borderColor(s);
		if (this.chromeStyle === "compact") {
			const out = [...lines];
			out[0] = composeTopBorder(width, this.slots.left(), this.slots.right(), paint, false);
			return out;
		}
		if (this.chromeStyle === "boxed") {
			return wrapWithSideBorders(lines, paint, {
				topBorder: composeTopBorder(width, this.slots.left(), this.slots.right(), paint, true),
			});
		}
		return lines;
	}
}
