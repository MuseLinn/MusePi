import { Container, type SelectItem, SelectList, type SgrMouseEvent } from "@musepi/pi-tui";
import { t } from "../../i18n/index.js";
import { getSelectListTheme } from "../../modes/theme/theme";
import { DynamicBorder } from "./dynamic-border";
import { routeSelectListMouseWithTopBorder } from "./select-list-mouse-routing";

/**
 * Component that renders a show images selector with borders
 */
export class ShowImagesSelectorComponent extends Container {
	#selectList: SelectList;

	constructor(currentValue: boolean, onSelect: (show: boolean) => void, onCancel: () => void) {
		super();

		const items: SelectItem[] = [
			{ value: "yes", label: t("errors.yes"), description: t("commands.showImagesInlineTerminal") },
			{ value: "no", label: t("errors.no"), description: t("commands.showTextPlaceholderInstead") },
		];

		// Add top border
		this.addChild(new DynamicBorder());

		// Create selector
		this.#selectList = new SelectList(items, 5, getSelectListTheme());

		// Preselect current value
		this.#selectList.setSelectedIndex(currentValue ? 0 : 1);

		this.#selectList.onSelect = item => {
			onSelect(item.value === "yes");
		};

		this.#selectList.onCancel = () => {
			onCancel();
		};

		this.addChild(this.#selectList);

		// Add bottom border
		this.addChild(new DynamicBorder());
	}

	getSelectList(): SelectList {
		return this.#selectList;
	}

	routeMouse(event: SgrMouseEvent, line: number, col: number): void {
		routeSelectListMouseWithTopBorder(this.#selectList, event, line, col);
	}
}
