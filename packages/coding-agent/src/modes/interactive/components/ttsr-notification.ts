import { Box, Container, Spacer, Text } from "@musepi/pi-tui";
import type { Rule } from "../../../export/ttsr.ts";
import { theme } from "../theme/theme.ts";

/** Collapsed view shows at most this many rules before eliding the rest. */
const MAX_COLLAPSED_RULES = 4;

/**
 * Component that renders a TTSR (Time Traveling Stream Rules) notification.
 * Shows when a rule violation is detected and the stream is being rewound.
 */
export class TtsrNotificationComponent extends Container {
	#box: Box;
	#expanded = false;
	#rules: Rule[];

	constructor(rules: Rule[]) {
		super();
		this.#rules = [...rules];

		this.addChild(new Spacer(1));

		this.#box = new Box(1, 1, (t) => theme.inverse(theme.fg("warning", t)));
		this.addChild(this.#box);

		this.#rebuild();
	}

	/** Merge additional rules into this block (deduped by rule name). */
	addRules(rules: Rule[]): void {
		const existing = new Set(this.#rules.map((r) => r.name));
		for (const rule of rules) {
			if (!existing.has(rule.name)) {
				this.#rules.push(rule);
				existing.add(rule.name);
			}
		}
		this.#rebuild();
	}

	setExpanded(expanded: boolean): void {
		if (this.#expanded !== expanded) {
			this.#expanded = expanded;
			this.#rebuild();
		}
	}

	isExpanded(): boolean {
		return this.#expanded;
	}

	#rebuild(): void {
		this.#box.clear();
		if (this.#rules.length === 1) {
			this.#renderSingle(this.#rules[0]!);
		} else {
			this.#renderMulti();
		}
	}

	#renderSingle(rule: Rule): void {
		const header = `\u26A0 Injecting rule: ${theme.bold(rule.name)}  \u21A9`;
		this.#box.addChild(new Text(header, 0, 0));

		const desc = rule.description?.trim();
		if (!desc) return;

		let displayText = desc;
		let truncated = false;
		if (!this.#expanded) {
			const lines = desc.split("\n");
			if (lines.length > 2) {
				displayText = `${lines.slice(0, 2).join("\n")}\u2026`;
				truncated = true;
			}
		}

		this.#box.addChild(new Spacer(1));
		this.#box.addChild(new Text(theme.italic(displayText), 0, 0));
		if (truncated) {
			this.#box.addChild(new Text(theme.italic(" (ctrl+o to expand)"), 0, 0));
		}
	}

	#renderMulti(): void {
		const header = `\u26A0 Injecting ${this.#rules.length} rules:  \u21A9`;
		this.#box.addChild(new Text(header, 0, 0));
		this.#box.addChild(new Spacer(1));

		const visible = this.#expanded ? this.#rules : this.#rules.slice(0, MAX_COLLAPSED_RULES);
		for (const rule of visible) {
			const desc = rule.description?.trim();
			let line = theme.bold(rule.name);
			if (desc) {
				if (!this.#expanded) {
					const firstLine = desc.split("\n")[0]?.trim() ?? "";
					line += ` \u2014 ${firstLine}`;
				} else {
					line += ` \u2014 ${desc}`;
				}
			}
			this.#box.addChild(new Text(`  ${line}`, 0, 0));
		}

		if (!this.#expanded && this.#rules.length > MAX_COLLAPSED_RULES) {
			this.#box.addChild(
				new Text(
					theme.italic(`  ... and ${this.#rules.length - MAX_COLLAPSED_RULES} more (ctrl+o to expand)`),
					0,
					0,
				),
			);
		}
	}
}
