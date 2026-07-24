/**
 * Checkbox-style selector component.
 * Displays a list of items with [x]/[ ] toggles and keyboard navigation.
 */

import { type Component, Container, getKeybindings, Spacer, Text, type TUI } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";
import { CountdownTimer } from "./countdown-timer.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { keyHint, rawKeyHint } from "./keybinding-hints.ts";

export interface CheckboxItem {
	label: string;
	checked: boolean;
	data?: unknown;
}

export interface CheckboxSelectorOptions {
	title?: string;
	tui?: TUI;
	timeout?: number;
	onToggleToolsExpanded?: () => void;
}

export class CheckboxSelectorComponent extends Container {
	private items: CheckboxItem[];
	private listContainer!: Container;
	private onConfirmCallback: (items: CheckboxItem[]) => void;
	private onCancelCallback: () => void;
	private countdown: CountdownTimer | undefined;
	private selectedIndex = 0;
	private onToggleToolsExpanded: (() => void) | undefined;

	constructor(
		items: CheckboxItem[],
		onConfirm: (items: CheckboxItem[]) => void,
		onCancel: () => void,
		opts?: CheckboxSelectorOptions,
	) {
		super();

		this.items = items;
		this.onConfirmCallback = onConfirm;
		this.onCancelCallback = onCancel;
		this.onToggleToolsExpanded = opts?.onToggleToolsExpanded;

		const title = opts?.title ?? "Select items to import";
		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
		this.addChild(new Spacer(1));
		if (opts?.timeout && opts.timeout > 0 && opts.tui) {
			this.countdown = new CountdownTimer(
				opts.timeout,
				opts.tui,
				(_seconds) => {}, // no tick display
				() => onCancel(),
			);
			this.addChild(this.countdown as unknown as Component);
		}
		this.addChild(new Spacer(1));
		this.addChild(
			new Text(
				rawKeyHint("↑↓", "navigate") +
					"  " +
					rawKeyHint("space", "toggle") +
					"  " +
					keyHint("tui.select.confirm", "confirm") +
					"  " +
					keyHint("tui.select.cancel", "cancel"),
				1,
				0,
			),
		);
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());

		this.updateList();
	}

	private updateList(): void {
		this.listContainer.clear();
		for (let i = 0; i < this.items.length; i++) {
			const item = this.items[i];
			const isFocused = i === this.selectedIndex;
			const checkbox = item.checked ? "[x]" : "[ ]";
			const prefix = isFocused ? theme.fg("accent", "→ ") : "  ";
			const label = isFocused
				? theme.fg("accent", `${checkbox} ${item.label}`)
				: `${checkbox} ${theme.fg("text", item.label)}`;
			this.listContainer.addChild(new Text(`${prefix}${label}`, 1, 0));
		}
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		if (kb.matches(keyData, "app.tools.expand")) {
			this.onToggleToolsExpanded?.();
		} else if (kb.matches(keyData, "tui.select.up") || keyData === "k") {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			this.updateList();
		} else if (kb.matches(keyData, "tui.select.down") || keyData === "j") {
			this.selectedIndex = Math.min(this.items.length - 1, this.selectedIndex + 1);
			this.updateList();
		} else if (keyData === " ") {
			// Space toggles checkbox for the focused item
			const item = this.items[this.selectedIndex];
			if (item) {
				item.checked = !item.checked;
				this.updateList();
			}
		} else if (kb.matches(keyData, "tui.select.confirm") || keyData === "\n") {
			this.onConfirmCallback(this.items.filter((i) => i.checked));
		} else if (kb.matches(keyData, "tui.select.cancel")) {
			this.onCancelCallback();
		}
	}

	dispose(): void {
		this.countdown?.dispose();
	}
}
