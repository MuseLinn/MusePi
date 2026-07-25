import { Container, SelectList, Spacer, Text, TruncatedText } from "@musepi/pi-tui";
import { getSelectListTheme, theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";

export interface ResetUsageAccount {
	label: string;
	availableCount: number;
}

/**
 * Account picker for `/usage reset`. Lists accounts with their saved
 * rate-limit reset counts. Because a reset is a scarce, irreversible credit,
 * Enter requires a second press to confirm.
 */
export class ResetUsageSelectorComponent extends Container {
	#selectList: SelectList;
	#accounts: ResetUsageAccount[];
	#pendingIndex: number | null = null;
	#statusText: Text = new Text("", 1, 0);
	#onSelectCallback: (account: ResetUsageAccount) => void;
	#onCancelCallback: () => void;

	constructor(accounts: ResetUsageAccount[], onSelect: (account: ResetUsageAccount) => void, onCancel: () => void) {
		super();
		this.#accounts = accounts;
		this.#onSelectCallback = onSelect;
		this.#onCancelCallback = onCancel;

		const items: import("@musepi/pi-tui").SelectItem[] = accounts.map((account) => ({
			value: account.label,
			label: account.label,
			description: account.availableCount > 0 ? `${account.availableCount} saved resets` : "no resets available",
		}));

		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		this.addChild(new TruncatedText(theme.bold("Spend a saved rate-limit reset:")));
		this.addChild(new Spacer(1));

		this.#selectList = new SelectList(items, 10, getSelectListTheme());

		const firstRedeemable = accounts.findIndex((a) => a.availableCount > 0);
		if (firstRedeemable >= 0) {
			this.#selectList.setSelectedIndex(firstRedeemable);
		}

		this.#selectList.onSelect = (item) => {
			const index = items.indexOf(item);
			if (index < 0) return;

			if (this.#pendingIndex === index) {
				// Second press — confirm
				this.#onSelectCallback(this.#accounts[index]);
			} else {
				// First press — prompt for confirmation
				this.#pendingIndex = index;
				const account = this.#accounts[index];
				this.#statusText.setText(
					theme.fg("warning", `  Press Enter again to spend 1 reset for ${account.label}, Esc to cancel`),
				);
				this.invalidate();
			}
		};

		this.#selectList.onCancel = () => {
			if (this.#pendingIndex !== null) {
				this.#pendingIndex = null;
				this.#updateStatus();
			} else {
				this.#onCancelCallback();
			}
		};

		this.addChild(this.#selectList);
		this.addChild(new Spacer(1));
		this.addChild(this.#statusText);
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());
		this.#updateStatus();
	}

	#updateStatus(): void {
		if (this.#pendingIndex !== null) {
			const account = this.#accounts[this.#pendingIndex];
			this.#statusText.setText(
				theme.fg("warning", `  Press Enter again to spend 1 reset for ${account.label}, Esc to cancel`),
			);
		} else {
			this.#statusText.setText(theme.fg("muted", "  ↑/↓ select · ↵ spend a reset · Esc cancel"));
		}
	}

	getSelectList(): SelectList {
		return this.#selectList;
	}
}
