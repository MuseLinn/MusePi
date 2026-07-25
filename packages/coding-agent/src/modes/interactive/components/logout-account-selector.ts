import { Container, type SelectItem, SelectList, Spacer, TruncatedText } from "@musepi/pi-tui";
import { getSelectListTheme, theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";

export interface LogoutAccount {
	label: string;
	active: boolean;
}

/** Account picker for `/logout` after the provider has been selected. */
export class LogoutAccountSelectorComponent extends Container {
	#selectList: SelectList;

	constructor(
		providerName: string,
		accounts: LogoutAccount[],
		onSelect: (account: LogoutAccount) => void,
		onCancel: () => void,
	) {
		super();

		const items: SelectItem[] = accounts.map((account) => ({
			value: account.label,
			label: account.active ? `${account.label} (active)` : account.label,
			description: undefined,
		}));

		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		this.addChild(new TruncatedText(theme.bold(`Select ${providerName} account to log out:`)));
		this.addChild(new Spacer(1));

		this.#selectList = new SelectList(items, 10, getSelectListTheme());

		// Preselect active account
		const activeIndex = accounts.findIndex((a) => a.active);
		if (activeIndex !== -1) {
			this.#selectList.setSelectedIndex(activeIndex);
		}

		this.#selectList.onSelect = (item) => {
			const index = items.indexOf(item);
			if (index >= 0) {
				onSelect(accounts[index]);
			}
		};

		this.#selectList.onCancel = () => {
			onCancel();
		};

		this.addChild(this.#selectList);
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());
	}

	getSelectList(): SelectList {
		return this.#selectList;
	}
}
