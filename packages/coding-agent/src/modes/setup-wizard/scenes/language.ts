import { routeSelectListMouse, type SelectItem, SelectList, type SgrMouseEvent } from "@musepi/pi-tui";
import { t } from "../../../i18n/index.js";
import { getSelectListTheme } from "../../theme/theme.js";
import type { SetupScene, SetupSceneController, SetupSceneHost } from "./types";

class LanguageSceneController implements SetupSceneController {
	title = t("Language / 语言");
	subtitle = t("Choose the interface language for setup and the TUI.");
	#selectList: SelectList;
	#disposed = false;

	constructor(private readonly host: SetupSceneHost) {
		// Evaluated at mount so the locale is resolved when the scene opens.
		const items: readonly SelectItem[] = [
			{ value: "en-US", label: "English", description: t("Use English for setup and the TUI") },
			{ value: "zh-CN", label: "简体中文", description: "使用中文进行设置和界面显示" },
		];
		const current = (host.ctx.settings.get("settings.locale") as string | undefined) ?? "en-US";
		const index = items.findIndex(item => item.value === current);
		this.#selectList = new SelectList(items, Math.max(1, items.length), getSelectListTheme());
		this.#selectList.setSelectedIndex(index >= 0 ? index : 0);
		this.#selectList.onSelect = async item => {
			await this.#select(item.value);
		};
		this.#selectList.onCancel = () => {
			this.host.finish("skipped");
		};
	}

	dispose(): void {
		this.#disposed = true;
	}

	invalidate(): void {
		this.#selectList.invalidate();
	}

	handleInput(data: string): void {
		this.#selectList.handleInput(data);
	}

	routeMouse(event: SgrMouseEvent, line: number, _col: number): void {
		routeSelectListMouse(this.#selectList, event, line);
	}

	render(width: number, maxLines?: number): readonly string[] {
		const budget = maxLines ?? Number.POSITIVE_INFINITY;
		const lines = [this.subtitle, ""];
		if (maxLines !== undefined) {
			this.#selectList.setMaxVisible(Math.max(1, Math.min(8, budget - lines.length - 1)));
		}
		lines.push(...this.#selectList.render(width));
		return lines;
	}

	async #select(value: string): Promise<void> {
		if (this.#disposed) return;
		if (value !== "en-US" && value !== "zh-CN") return;
		this.host.ctx.settings.set("settings.locale", value as "en-US" | "zh-CN");
		await this.#apply(value);
		this.host.finish("done");
	}

	async #apply(value: string): Promise<void> {
		try {
			const { setLocale } = await import("../../../i18n/index.js");
			setLocale(value);
		} catch {
			// best-effort; static import is intentionally avoided to keep the
			// setup-wizard cold-start path lightweight.
		}
	}
}

export const languageSetupScene: SetupScene = {
	id: "language",
	get title() {
		return t("Language / 语言");
	},
	minVersion: 1,
	mount: host => new LanguageSceneController(host),
};
