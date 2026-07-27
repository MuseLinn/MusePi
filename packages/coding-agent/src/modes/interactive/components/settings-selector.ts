import type { ResolvedMusepiSettings } from "@musepi/core";
import { t } from "@musepi/core/i18n";
import type { ThinkingLevel } from "@musepi/pi-agent-core";
import type { Transport } from "@musepi/pi-ai";
import {
	type Component,
	Container,
	getCapabilities,
	Input,
	type SelectItem,
	SelectList,
	type SelectListLayoutOptions,
	type SettingItem,
	SettingsList,
	type SgrMouseEvent,
	Spacer,
	type Tab,
	TabBar,
	Text,
} from "@musepi/pi-tui";
import { formatHttpIdleTimeoutMs, HTTP_IDLE_TIMEOUT_CHOICES } from "../../../core/http-dispatcher.ts";
import type { DefaultProjectTrust, WarningSettings } from "../../../core/settings-manager.ts";
import { SEARCH_PROVIDER_LABELS, SEARCH_PROVIDER_OPTIONS } from "../../../web/search/types.ts";
import {
	getSelectListTheme,
	getSettingsListTheme,
	getTabBarTheme,
	parseAutoThemeSetting,
	type TerminalTheme,
	theme,
} from "../theme/theme.ts";
import { keyDisplayText, rawKeyHint } from "./keybinding-hints.ts";
import {
	formatMusepiValue,
	MUSEPI_SETTING_DEFS,
	musepiSettingDescription,
	parseMusepiValue,
	TIMEOUT_PRESETS,
} from "./musepi-settings-defs.ts";
import { bottomBorder, divider, row, topBorder } from "./overlay-box.ts";

const SETTINGS_SUBMENU_SELECT_LIST_LAYOUT: SelectListLayoutOptions = {
	minPrimaryColumnWidth: 12,
	maxPrimaryColumnWidth: 32,
};

const THINKING_DESCRIPTIONS: Record<ThinkingLevel, string> = {
	off: "No reasoning",
	minimal: "Very brief reasoning (~1k tokens)",
	low: "Light reasoning (~2k tokens)",
	medium: "Moderate reasoning (~8k tokens)",
	high: "Deep reasoning (~16k tokens)",
	xhigh: "Extra-high reasoning (~32k tokens)",
	max: "Maximum reasoning",
};

const DEFAULT_PROJECT_TRUST_LABELS: Record<DefaultProjectTrust, string> = {
	ask: "Ask",
	always: "Always trust",
	never: "Never trust",
};

const DEFAULT_PROJECT_TRUST_BY_LABEL = new Map(
	Object.entries(DEFAULT_PROJECT_TRUST_LABELS).map(([value, label]) => [label, value as DefaultProjectTrust]),
);

export interface SettingsConfig {
	autoCompact: boolean;
	showImages: boolean;
	imageWidthCells: number;
	autoResizeImages: boolean;
	blockImages: boolean;
	enableSkillCommands: boolean;
	steeringMode: "all" | "one-at-a-time";
	followUpMode: "all" | "one-at-a-time";
	transport: Transport;
	httpIdleTimeoutMs: number;
	thinkingLevel: ThinkingLevel;
	availableThinkingLevels: ThinkingLevel[];
	currentTheme: string;
	terminalTheme: TerminalTheme;
	availableThemes: string[];
	hideThinkingBlock: boolean;
	showCacheMissNotices: boolean;
	collapseChangelog: boolean;
	enableInstallTelemetry: boolean;
	doubleEscapeAction: "fork" | "tree" | "none";
	treeFilterMode: "default" | "no-tools" | "user-only" | "labeled-only" | "all";
	showHardwareCursor: boolean;
	editorPaddingX: number;
	outputPad: 0 | 1;
	autocompleteMaxVisible: number;
	quietStartup: boolean;
	defaultProjectTrust: DefaultProjectTrust;
	clearOnShrink: boolean;
	showTerminalProgress: boolean;
	warnings: WarningSettings;
	/** Resolved MusePi feature settings (musepi.*), edited in the MusePi submenu. */
	musepi: ResolvedMusepiSettings;
	/** Global settings.json path, shown in "edit in file" info panels. */
	musepiSettingsPath: string;
}

export interface SettingsCallbacks {
	onAutoCompactChange: (enabled: boolean) => void;
	onShowImagesChange: (enabled: boolean) => void;
	onImageWidthCellsChange: (width: number) => void;
	onAutoResizeImagesChange: (enabled: boolean) => void;
	onBlockImagesChange: (blocked: boolean) => void;
	onEnableSkillCommandsChange: (enabled: boolean) => void;
	onSteeringModeChange: (mode: "all" | "one-at-a-time") => void;
	onFollowUpModeChange: (mode: "all" | "one-at-a-time") => void;
	onTransportChange: (transport: Transport) => void;
	onHttpIdleTimeoutMsChange: (timeoutMs: number) => void;
	onThinkingLevelChange: (level: ThinkingLevel) => void;
	onThemeChange: (theme: string) => void;
	onThemePreview?: (theme: string) => void;
	onHideThinkingBlockChange: (hidden: boolean) => void;
	onShowCacheMissNoticesChange: (shown: boolean) => void;
	onCollapseChangelogChange: (collapsed: boolean) => void;
	onEnableInstallTelemetryChange: (enabled: boolean) => void;
	onDoubleEscapeActionChange: (action: "fork" | "tree" | "none") => void;
	onTreeFilterModeChange: (mode: "default" | "no-tools" | "user-only" | "labeled-only" | "all") => void;
	onShowHardwareCursorChange: (enabled: boolean) => void;
	onEditorPaddingXChange: (padding: number) => void;
	onOutputPadChange: (padding: 0 | 1) => void;
	onAutocompleteMaxVisibleChange: (maxVisible: number) => void;
	onQuietStartupChange: (enabled: boolean) => void;
	onDefaultProjectTrustChange: (defaultProjectTrust: DefaultProjectTrust) => void;
	onClearOnShrinkChange: (enabled: boolean) => void;
	onShowTerminalProgressChange: (enabled: boolean) => void;
	onWarningsChange: (warnings: WarningSettings) => void;
	onMusepiChange: (path: string, value: unknown) => void;
	onCancel: () => void;
}

/**
 * A submenu component for selecting from a list of options.
 */
class WarningSettingsSubmenu extends Container {
	private settingsList: SettingsList;
	private state: WarningSettings;

	constructor(warnings: WarningSettings, onChange: (warnings: WarningSettings) => void, onCancel: () => void) {
		super();

		this.state = { ...warnings };

		const items: SettingItem[] = [
			{
				id: "anthropic-extra-usage",
				label: "Anthropic extra usage",
				description: "Warn when Anthropic subscription auth may use paid extra usage",
				currentValue: (this.state.anthropicExtraUsage ?? true) ? "true" : "false",
				values: ["true", "false"],
			},
		];

		this.settingsList = new SettingsList(
			items,
			Math.min(items.length, 10),
			getSettingsListTheme(),
			(id, newValue) => {
				switch (id) {
					case "anthropic-extra-usage":
						this.state = { ...this.state, anthropicExtraUsage: newValue === "true" };
						onChange({ ...this.state });
						break;
				}
			},
			onCancel,
		);

		this.addChild(this.settingsList);
	}

	handleInput(data: string): void {
		this.settingsList.handleInput(data);
	}
}

/**
 * A submenu for editing a free-text setting value (e.g. a model spec).
 * Enter saves the trimmed value; Esc cancels without changes.
 */
class TextInputSubmenu extends Container {
	private input: Input;

	constructor(
		title: string,
		description: string,
		currentValue: string,
		onSubmit: (value: string) => void,
		onCancel: () => void,
	) {
		super();

		this.addChild(new Text(theme.bold(theme.fg("accent", title)), 0, 0));
		if (description) {
			this.addChild(new Spacer(1));
			this.addChild(new Text(theme.fg("muted", description), 0, 0));
		}
		this.addChild(new Spacer(1));

		this.input = new Input();
		if (currentValue && currentValue !== "(unset)") {
			this.input.setValue(currentValue);
		}
		this.input.onSubmit = (value) => onSubmit(value.trim());
		this.input.onEscape = onCancel;
		this.addChild(this.input);

		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("dim", "  Enter to save · Esc to cancel"), 0, 0));
	}

	handleInput(data: string): void {
		this.input.handleInput(data);
	}
}

/**
 * A read-only submenu explaining how to edit a nested setting
 * (server registries, string lists) directly in settings.json.
 */
class InfoSubmenu extends Container {
	private onDone: () => void;

	constructor(title: string, lines: string[], onDone: () => void) {
		super();
		this.onDone = onDone;

		this.addChild(new Text(theme.bold(theme.fg("accent", title)), 0, 0));
		this.addChild(new Spacer(1));
		for (const line of lines) {
			this.addChild(new Text(theme.fg("muted", line), 0, 0));
		}
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("dim", "  Esc to go back"), 0, 0));
	}

	handleInput(data: string): void {
		if (data === "\x1b" || data === "\r" || data === "\n") {
			this.onDone();
		}
	}
}

/**
 * The MusePi submenu: every musepi.* feature setting, grouped by feature
 * area (Memory, MCP, LSP, Advisor, Model Roles, Tools, Swarm, Interface,
 * Updates & Compat) with type-to-search. Booleans/enums/numbers cycle in
 * place, model specs open a text input, and nested registries open an
 * info panel pointing at settings.json.
 */
class MusepiSettingsSubmenu extends Container {
	private settingsList: SettingsList;

	constructor(
		values: ResolvedMusepiSettings,
		settingsPath: string,
		onChange: (path: string, value: unknown) => void,
		onCancel: () => void,
	) {
		super();

		const defsById = new Map(MUSEPI_SETTING_DEFS.map((def) => [def.path, def]));

		const items: SettingItem[] = MUSEPI_SETTING_DEFS.map((def) => {
			const description = musepiSettingDescription(def.path);
			const item: SettingItem = {
				id: def.path,
				label: t(def.label),
				section: t(def.section),
				description,
				currentValue: formatMusepiValue(def, values),
			};

			switch (def.kind) {
				case "bool":
					item.values = ["true", "false"];
					break;
				case "enum":
					item.values = [...(def.options ?? [])];
					break;
				case "number":
					item.values = (def.presets ?? []).map(String);
					break;
				case "text":
					item.submenu = (currentValue, done) =>
						new TextInputSubmenu(
							`${t(def.section)} · ${t(def.label)}`,
							description,
							currentValue,
							(value) => done(value.length > 0 ? value : "(unset)"),
							() => done(),
						);
					break;
				case "info":
					item.submenu = (_currentValue, done) =>
						new InfoSubmenu(
							`${t(def.section)} · ${t(def.label)}`,
							[...(def.info ?? []), "", `Settings file: ${settingsPath}`],
							() => done(),
						);
					break;
			}
			return item;
		});

		this.settingsList = new SettingsList(
			items,
			12,
			getSettingsListTheme(),
			(id, newValue) => {
				const def = defsById.get(id);
				if (!def) return;
				const parsed = parseMusepiValue(def, newValue);
				if (parsed !== undefined) {
					onChange(def.path, parsed);
				}
			},
			onCancel,
			{ enableSearch: true },
		);

		this.addChild(this.settingsList);
	}

	handleInput(data: string): void {
		this.settingsList.handleInput(data);
	}
}

class SelectSubmenu extends Container {
	private selectList: SelectList;

	constructor(
		title: string,
		description: string,
		options: SelectItem[],
		currentValue: string,
		onSelect: (value: string) => void,
		onCancel: () => void,
		onSelectionChange?: (value: string) => void,
	) {
		super();

		// Title
		this.addChild(new Text(theme.bold(theme.fg("accent", title)), 0, 0));

		// Description
		if (description) {
			this.addChild(new Spacer(1));
			this.addChild(new Text(theme.fg("muted", description), 0, 0));
		}

		// Spacer
		this.addChild(new Spacer(1));

		// Select list
		this.selectList = new SelectList(
			options,
			Math.min(options.length, 10),
			getSelectListTheme(),
			SETTINGS_SUBMENU_SELECT_LIST_LAYOUT,
		);

		// Pre-select current value
		const currentIndex = options.findIndex((o) => o.value === currentValue);
		if (currentIndex !== -1) {
			this.selectList.setSelectedIndex(currentIndex);
		}

		this.selectList.onSelect = (item) => {
			onSelect(item.value);
		};

		this.selectList.onCancel = onCancel;

		if (onSelectionChange) {
			this.selectList.onSelectionChange = (item) => {
				onSelectionChange(item.value);
			};
		}

		this.addChild(this.selectList);

		// Hint
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("dim", "  Enter to select · Esc to go back"), 0, 0));
	}

	handleInput(data: string): void {
		this.selectList.handleInput(data);
	}
}

function themeItems(availableThemes: string[]): SelectItem[] {
	return availableThemes.map((name) => ({ value: name, label: name }));
}

const AUTOMATIC_THEME_VALUE = "/";

function singleModeThemeItems(availableThemes: string[]): SelectItem[] {
	return [
		{
			value: AUTOMATIC_THEME_VALUE,
			label: "Automatic",
			description: "Use separate themes for light and dark terminal appearance",
		},
		...themeItems(availableThemes),
	];
}

function preferredTheme(availableThemes: string[], preferred: string | undefined, fallback: string): string {
	if (preferred && availableThemes.includes(preferred)) return preferred;
	if (availableThemes.includes(fallback)) return fallback;
	return availableThemes[0] ?? fallback;
}

function defaultAutomaticThemes(
	currentThemeSetting: string,
	availableThemes: string[],
): { lightTheme: string; darkTheme: string } {
	const autoTheme = parseAutoThemeSetting(currentThemeSetting);
	if (autoTheme) return autoTheme;

	const currentFixedTheme = currentThemeSetting.includes("/") ? undefined : currentThemeSetting;
	const themeName = preferredTheme(availableThemes, currentFixedTheme, "dark");
	return { lightTheme: themeName, darkTheme: themeName };
}

class ThemeSubmenu extends Container {
	private inputComponent: Component | undefined;
	private readonly callbacks: SettingsCallbacks;
	private readonly availableThemes: string[];
	private readonly terminalTheme: TerminalTheme;
	private readonly onDone: (selectedValue?: string) => void;
	private readonly originalThemeSetting: string;
	private mode: "single" | "automatic";
	private singleTheme: string;
	private lightTheme: string;
	private darkTheme: string;

	constructor(
		currentThemeSetting: string,
		terminalTheme: TerminalTheme,
		availableThemes: string[],
		callbacks: SettingsCallbacks,
		onDone: (selectedValue?: string) => void,
	) {
		super();
		this.callbacks = callbacks;
		this.availableThemes = availableThemes;
		this.terminalTheme = terminalTheme;
		this.onDone = onDone;
		this.originalThemeSetting = currentThemeSetting;
		const autoTheme = parseAutoThemeSetting(currentThemeSetting);
		const automaticThemes = defaultAutomaticThemes(currentThemeSetting, availableThemes);
		const fixedTheme = autoTheme || currentThemeSetting.includes("/") ? undefined : currentThemeSetting;
		this.mode = autoTheme ? "automatic" : "single";
		this.lightTheme = automaticThemes.lightTheme;
		this.darkTheme = automaticThemes.darkTheme;
		this.singleTheme = preferredTheme(
			availableThemes,
			fixedTheme ?? (autoTheme ? this.getActiveAutomaticTheme() : undefined),
			"dark",
		);

		if (this.mode === "automatic") {
			this.showAutomaticMenu();
		} else {
			this.showSingleMenu();
		}
	}

	handleInput(data: string): void {
		this.inputComponent?.handleInput?.(data);
	}

	private setContent(renderComponent: Component, inputComponent: Component = renderComponent): void {
		this.clear();
		this.addChild(renderComponent);
		this.inputComponent = inputComponent;
	}

	private showSingleMenu(): void {
		this.mode = "single";
		const menu = new SelectSubmenu(
			"Theme",
			"Select a theme, or choose Automatic to follow terminal appearance.",
			singleModeThemeItems(this.availableThemes),
			this.singleTheme,
			(value) => {
				if (value === AUTOMATIC_THEME_VALUE) {
					this.mode = "automatic";
					this.callbacks.onThemePreview?.(this.getThemeSetting());
					this.showAutomaticMenu();
					return;
				}

				this.singleTheme = value;
				this.apply(value);
			},
			() => this.cancel(),
			(value) => {
				this.callbacks.onThemePreview?.(value === AUTOMATIC_THEME_VALUE ? this.getAutomaticThemeSetting() : value);
			},
		);
		this.setContent(menu);
	}

	private showAutomaticMenu(): void {
		this.mode = "automatic";
		const content = new Container();
		content.addChild(new Text(theme.bold(theme.fg("accent", "Automatic Theme")), 0, 0));
		content.addChild(new Spacer(1));
		content.addChild(new Text(theme.fg("muted", "Choose themes for terminal light and dark appearance."), 0, 0));
		content.addChild(new Text(theme.fg("muted", "Light/dark detection requires terminal support."), 0, 0));
		content.addChild(new Spacer(1));

		const items: SettingItem[] = [
			{
				id: "light-theme",
				label: "Light theme",
				description: "Theme to use in automatic mode when the terminal is light",
				currentValue: this.lightTheme,
				submenu: (currentValue, done) =>
					this.createThemeSelect(
						"Light Theme",
						"Select the theme to use for light terminal appearance",
						currentValue,
						done,
						(value) => {
							this.lightTheme = value;
							this.callbacks.onThemePreview?.(this.getThemeSetting());
							done(value);
						},
					),
			},
			{
				id: "dark-theme",
				label: "Dark theme",
				description: "Theme to use in automatic mode when the terminal is dark",
				currentValue: this.darkTheme,
				submenu: (currentValue, done) =>
					this.createThemeSelect(
						"Dark Theme",
						"Select the theme to use for dark terminal appearance",
						currentValue,
						done,
						(value) => {
							this.darkTheme = value;
							this.callbacks.onThemePreview?.(this.getThemeSetting());
							done(value);
						},
					),
			},
			{
				id: "apply",
				label: "Apply",
				description: "Save and go back",
				currentValue: "save and go back",
				values: ["save and go back"],
			},
			{
				id: "single-mode",
				label: "Change mode",
				description: "Switch to one theme for light and dark",
				currentValue: "switch to single theme",
				values: ["switch to single theme"],
			},
		];

		const settingsList = new SettingsList(
			items,
			Math.min(items.length, 10),
			getSettingsListTheme(),
			(id) => {
				switch (id) {
					case "single-mode":
						this.mode = "single";
						this.singleTheme = this.getActiveAutomaticTheme();
						this.callbacks.onThemePreview?.(this.singleTheme);
						this.showSingleMenu();
						break;
					case "apply":
						this.apply(this.getAutomaticThemeSetting());
						break;
				}
			},
			() => this.cancel(),
		);
		content.addChild(settingsList);
		this.setContent(content, settingsList);
	}

	private createThemeSelect(
		title: string,
		description: string,
		currentValue: string,
		done: (selectedValue?: string) => void,
		onSelect: (value: string) => void,
	): SelectSubmenu {
		return new SelectSubmenu(
			title,
			description,
			themeItems(this.availableThemes),
			currentValue,
			onSelect,
			() => {
				this.callbacks.onThemePreview?.(this.getThemeSetting());
				done();
			},
			(value) => this.callbacks.onThemePreview?.(value),
		);
	}

	private getThemeSetting(): string {
		return this.mode === "automatic" ? this.getAutomaticThemeSetting() : this.singleTheme;
	}

	private getActiveAutomaticTheme(): string {
		return this.terminalTheme === "light" ? this.lightTheme : this.darkTheme;
	}

	private getAutomaticThemeSetting(): string {
		return `${this.lightTheme}/${this.darkTheme}`;
	}

	private apply(themeSetting: string): void {
		this.onDone(themeSetting);
	}

	private cancel(): void {
		this.callbacks.onThemePreview?.(this.originalThemeSetting);
		this.onDone();
	}
}

/** Map tab IDs to the section/group names shown within that tab.
 * Items whose section matches appear under the tab; consecutive items
 * with different sections render group headings automatically.
 * Omitting a tab here falls back to filtering by tab label (current behavior). */
const TAB_SECTIONS: Record<string, string[]> = {
	model: ["Thinking", "Advisor"],
	appearance: ["Theme", "Display", "Images"],
	providers: ["Services", "MCP", "LSP", "Advanced"],
};

/**
 * Main settings selector component.
 */
export class SettingsSelectorComponent extends Container {
	private settingsList: SettingsList;
	private tabBar: TabBar;
	private tabDefs: Tab[];
	constructor(config: SettingsConfig, callbacks: SettingsCallbacks) {
		super();

		const supportsImages = getCapabilities().images;
		const followUpKey = keyDisplayText("app.message.followUp");
		let currentWarnings = { ...config.warnings };

		const items: SettingItem[] = [
			// ── Session ────────────────────────────────────────────────
			{
				id: "autocompact",
				label: "Auto-compact",
				section: "Session",
				description: "Automatically compact context when it gets too large",
				currentValue: config.autoCompact ? "true" : "false",
				values: ["true", "false"],
			},
			{
				id: "steering-mode",
				label: "Steering mode",
				section: "Session",
				description:
					"Enter while streaming queues steering messages. 'one-at-a-time': deliver one, wait for response. 'all': deliver all at once.",
				currentValue: config.steeringMode,
				values: ["one-at-a-time", "all"],
			},
			{
				id: "follow-up-mode",
				label: "Follow-up mode",
				section: "Session",
				description: `${followUpKey} queues follow-up messages until agent stops. 'one-at-a-time': deliver one, wait for response. 'all': deliver all at once.`,
				currentValue: config.followUpMode,
				values: ["one-at-a-time", "all"],
			},
			{
				id: "default-project-trust",
				label: "Default project trust",
				section: "Session",
				description: "Fallback behavior when no extension or saved trust decision decides project trust",
				currentValue: DEFAULT_PROJECT_TRUST_LABELS[config.defaultProjectTrust],
				values: Object.values(DEFAULT_PROJECT_TRUST_LABELS),
			},
			{
				id: "warnings",
				label: "Warnings",
				section: "Session",
				description: "Enable or disable individual warnings",
				currentValue: "configure",
				submenu: (_currentValue, done) =>
					new WarningSettingsSubmenu(
						currentWarnings,
						(warnings) => {
							currentWarnings = warnings;
							callbacks.onWarningsChange(warnings);
						},
						() => done(),
					),
			},

			// ── Appearance ─────────────────────────────────────────────
			{
				id: "theme",
				label: "Theme",
				section: "Theme",
				description: "Color theme for the interface",
				currentValue: config.currentTheme,
				submenu: (currentValue, done) =>
					new ThemeSubmenu(currentValue, config.terminalTheme, config.availableThemes, callbacks, done),
			},
			{
				id: "hide-thinking",
				label: "Hide thinking",
				section: "Display",
				description: "Hide thinking blocks in assistant responses",
				currentValue: config.hideThinkingBlock ? "true" : "false",
				values: ["true", "false"],
			},
			{
				id: "cache-miss-notices",
				label: "Cache miss notices",
				section: "Display",
				description: "Show transcript notices for significant prompt-cache misses",
				currentValue: config.showCacheMissNotices ? "true" : "false",
				values: ["true", "false"],
			},
			{
				id: "collapse-changelog",
				label: "Collapse changelog",
				section: "Display",
				description: "Show condensed changelog after updates",
				currentValue: config.collapseChangelog ? "true" : "false",
				values: ["true", "false"],
			},
			{
				id: "quiet-startup",
				label: "Quiet startup",
				section: "Display",
				description: "Disable verbose printing at startup",
				currentValue: config.quietStartup ? "true" : "false",
				values: ["true", "false"],
			},
			{
				id: "show-hardware-cursor",
				label: "Show hardware cursor",
				section: "Display",
				description: "Show the terminal cursor while still positioning it for IME support",
				currentValue: config.showHardwareCursor ? "true" : "false",
				values: ["true", "false"],
			},
			{
				id: "editor-padding",
				label: "Editor padding",
				section: "Display",
				description: "Horizontal padding for input editor (0-3)",
				currentValue: String(config.editorPaddingX),
				values: ["0", "1", "2", "3"],
			},
			{
				id: "output-padding",
				label: "Output padding",
				section: "Display",
				description: "Horizontal padding for user messages, assistant messages, and thinking",
				currentValue: String(config.outputPad),
				values: ["0", "1"],
			},
			{
				id: "autocomplete-max-visible",
				label: "Autocomplete max items",
				section: "Display",
				description: "Max visible items in autocomplete dropdown (3-20)",
				currentValue: String(config.autocompleteMaxVisible),
				values: ["3", "5", "7", "10", "15", "20"],
			},
			{
				id: "clear-on-shrink",
				label: "Clear on shrink",
				section: "Display",
				description: "Clear empty rows when content shrinks (may cause flicker)",
				currentValue: config.clearOnShrink ? "true" : "false",
				values: ["true", "false"],
			},
			{
				id: "terminal-progress",
				label: "Terminal progress",
				section: "Display",
				description: "Show OSC 9;4 progress indicators in the terminal tab bar",
				currentValue: config.showTerminalProgress ? "true" : "false",
				values: ["true", "false"],
			},
			{
				id: "editor-style",
				label: "Editor style",
				section: "Display",
				description: "Editor chrome: boxed (╭╮╰╯), compact (embedded top bar), or plain",
				currentValue: config.musepi.tui?.style ?? "boxed",
				values: ["boxed", "compact", "plain"],
			},
			{
				id: "notifications-enabled",
				label: "Notifications",
				section: "Display",
				description: "Show desktop notifications for agent events",
				currentValue: config.musepi.notifications.enabled ? "true" : "false",
				values: ["true", "false"],
			},
			{
				id: "model-in-border",
				label: "Model in border",
				section: "Display",
				description: "Show model name in the editor top border",
				currentValue: config.musepi.tui?.modelInBorder ? "true" : "false",
				values: ["true", "false"],
			},
			{
				id: "goal-badge",
				label: "Goal badge",
				section: "Display",
				description: "Show goal mode badge in the status line",
				currentValue: config.musepi.goal?.badge ? "true" : "false",
				values: ["true", "false"],
			},

			// Image items (conditional on terminal image support)
			...(supportsImages
				? ([
						{
							id: "show-images",
							label: "Show images",
							section: "Display",
							description: "Render images inline in terminal",
							currentValue: config.showImages ? "true" : "false",
							values: ["true", "false"],
						},
						{
							id: "image-width-cells",
							label: "Image width",
							section: "Display",
							description: "Preferred inline image width in terminal cells",
							currentValue: String(config.imageWidthCells),
							values: ["60", "80", "120"],
						},
					] as SettingItem[])
				: []),
			{
				id: "auto-resize-images",
				label: "Auto-resize images",
				section: "Display",
				description: "Resize large images to 2000x2000 max for better model compatibility",
				currentValue: config.autoResizeImages ? "true" : "false",
				values: ["true", "false"],
			},
			{
				id: "block-images",
				label: "Block images",
				section: "Display",
				description: "Prevent images from being sent to LLM providers",
				currentValue: config.blockImages ? "true" : "false",
				values: ["true", "false"],
			},

			// ── Model ──────────────────────────────────────────────────
			{
				id: "thinking",
				label: "Thinking level",
				section: "Thinking",
				description: "Reasoning depth for thinking-capable models",
				currentValue: config.thinkingLevel,
				submenu: (currentValue, done) =>
					new SelectSubmenu(
						"Thinking Level",
						"Select reasoning depth for thinking-capable models",
						config.availableThinkingLevels.map((level) => ({
							value: level,
							label: level,
							description: THINKING_DESCRIPTIONS[level],
						})),
						currentValue,
						(value) => {
							callbacks.onThinkingLevelChange(value as ThinkingLevel);
							done(value);
						},
						() => done(),
					),
			},
			{
				id: "advisor-enabled",
				label: "Advisor",
				section: "Advisor",
				description: "Enable the advisor tool for review-model guidance",
				currentValue: config.musepi.advisor?.enabled ? "true" : "false",
				values: ["true", "false"],
			},
			{
				id: "advisor-model",
				label: "Advisor model",
				section: "Advisor",
				description: "Model spec for advisor reviews (e.g. openai/gpt-4o). Leave empty to use the session model.",
				currentValue: config.musepi.advisor?.model ?? "(session default)",
				submenu: (currentValue, done) =>
					new TextInputSubmenu(
						"Model · Advisor model",
						"Model spec for advisor reviews. Empty = use session model.",
						currentValue === "(session default)" ? "" : currentValue,
						(value) => {
							callbacks.onMusepiChange("advisor.model", value.length > 0 ? value : undefined);
							done(value.length > 0 ? value : "(session default)");
						},
						() => done(),
					),
			},

			// ── Interaction ────────────────────────────────────────────
			{
				id: "transport",
				label: "Transport",
				section: "Interaction",
				description: "Preferred transport for providers that support multiple transports",
				currentValue: config.transport,
				values: ["sse", "websocket", "websocket-cached", "auto"],
			},
			{
				id: "http-idle-timeout",
				label: "HTTP idle timeout",
				section: "Interaction",
				description:
					"Maximum idle gap while waiting for HTTP headers or body chunks. Disable for local models that pause longer than five minutes.",
				currentValue: formatHttpIdleTimeoutMs(config.httpIdleTimeoutMs),
				values: HTTP_IDLE_TIMEOUT_CHOICES.map((choice) => choice.label),
			},

			// ── Context ────────────────────────────────────────────────
			{
				id: "compaction-info",
				label: "Compaction strategy",
				section: "Context",
				description: "Context compaction and summarization settings",
				currentValue: config.musepi.compaction.strategy,
				submenu: (_currentValue, done) =>
					new InfoSubmenu(
						"Context · Compaction",
						[
							"Compaction: auto-triggered when context approaches the model's limit.",
							"Strategy: snapcompact merges tool results into summary blocks.",
							`Current: ${config.musepi.compaction.strategy}`,
							"",
							`Settings file: ${config.musepiSettingsPath}`,
						],
						() => done(),
					),
			},

			// ── Memory ─────────────────────────────────────────────────
			{
				id: "memory-enabled",
				label: "Memory",
				section: "Memory",
				description: "Enable long-term memory (markdown files with BM25 recall)",
				currentValue: config.musepi.memory.enabled ? "true" : "false",
				values: ["true", "false"],
			},
			{
				id: "memory-scope",
				label: "Memory scope",
				section: "Memory",
				description: "Scope of memory injection: project only, or project + global",
				currentValue: config.musepi.memory.scope,
				values: ["project", "global"],
			},
			{
				id: "hashline-editing",
				label: "Hashline editing",
				section: "Files",
				description: "Use hashline-based edit tracking (SWAP/DEL/INS with snapshot tags)",
				currentValue: config.musepi.edit.hashline ? "true" : "false",
				values: ["true", "false"],
			},
			{
				id: "enforce-seen-lines",
				label: "Enforce seen lines",
				section: "Files",
				description: "Reject edits referencing lines not displayed in the current transcript",
				currentValue: config.musepi.edit.enforceSeenLines ? "true" : "false",
				values: ["true", "false"],
			},
			// ── Shell ──────────────────────────────────────────────────
			{
				id: "skill-commands",
				label: "Skill commands",
				section: "Shell",
				description: "Register skills as /skill:name commands",
				currentValue: config.enableSkillCommands ? "true" : "false",
				values: ["true", "false"],
			},
			{
				id: "double-escape-action",
				label: "Double-escape action",
				section: "Shell",
				description: "Action when pressing Escape twice with empty editor",
				currentValue: config.doubleEscapeAction,
				values: ["tree", "fork", "none"],
			},
			{
				id: "tree-filter-mode",
				label: "Tree filter mode",
				section: "Shell",
				description: "Default filter when opening /tree",
				currentValue: config.treeFilterMode,
				values: ["default", "no-tools", "user-only", "labeled-only", "all"],
			},

			// ── Tools ──────────────────────────────────────────────────
			{
				id: "tool-select",
				label: "Tool select (experimental)",
				section: "Tools",
				description: "Progressive tool disclosure: model loads tools by name via select_tools",
				currentValue: config.musepi.toolSelect.enabled ? "true" : "false",
				values: ["true", "false"],
			},
			{
				id: "install-telemetry",
				label: "Install telemetry",
				section: "Tools",
				description: "Send an anonymous version/update ping after changelog-detected updates",
				currentValue: config.enableInstallTelemetry ? "true" : "false",
				values: ["true", "false"],
			},
			// ── Tasks ──────────────────────────────────────────────────
			{
				id: "swarm-max-concurrency",
				label: "Swarm concurrency",
				section: "Tasks",
				description: "Max parallel subagents in a swarm operation",
				currentValue: String(config.musepi.swarm.maxConcurrency),
				values: ["1", "2", "4", "8", "16"],
			},
			{
				id: "swarm-timeout-ms",
				label: "Swarm timeout (s)",
				section: "Tasks",
				description: "Max milliseconds a swarm operation can run before timeout",
				currentValue: String(config.musepi.swarm.timeoutMs),
				values: ["30000", "60000", "120000", "300000", "600000"],
			},
			{
				id: "swarm-isolation",
				label: "Swarm isolation",
				section: "Tasks",
				description: "Isolate subagent file changes: worktree (git worktree) or none (in-place)",
				currentValue: config.musepi.swarm.isolation,
				values: ["worktree", "none"],
			},
			{
				id: "swarm-model-tier",
				label: "Swarm model tier",
				section: "Tasks",
				description: "Model tier for subagent tasks: default, smol, or a specific model spec",
				currentValue: config.musepi.swarm.modelTier ?? "(default)",
				submenu: (currentValue, done) =>
					new TextInputSubmenu(
						"Tasks · Swarm model tier",
						"Model spec for subagent tasks (e.g. openai/gpt-4o-mini). Empty = use session default.",
						currentValue === "(default)" ? "" : currentValue,
						(value) => {
							callbacks.onMusepiChange("swarm.modelTier", value.length > 0 ? value : undefined);
							done(value.length > 0 ? value : "(default)");
						},
						() => done(),
					),
			},

			// ── Providers ──────────────────────────────────────────────
			{
				id: "web-search-provider",
				label: "Web search provider",
				section: "Services",
				description: "Preferred backend for the web_search tool",
				currentValue:
					(SEARCH_PROVIDER_LABELS as Record<string, string>)[config.musepi.providers.webSearch] ??
					config.musepi.providers.webSearch,
				values: SEARCH_PROVIDER_OPTIONS.map((o) => o.label),
			},
			{
				id: "load-legacy-extensions",
				label: "Load legacy pi extensions",
				section: "Services",
				description: "Load extensions registered via pi_extensions in settings.json",
				currentValue: config.musepi.compat.loadPiExtensions ? "true" : "false",
				values: ["true", "false"],
			},
			{
				id: "mcp-enabled",
				label: "MCP servers",
				section: "MCP",
				description: "Enable MCP (Model Context Protocol) server integration",
				currentValue: config.musepi.mcp.enabled ? "true" : "false",
				values: ["true", "false"],
			},
			{
				id: "mcp-startup-discovery",
				label: "MCP startup discovery",
				section: "MCP",
				description: "Auto-discover MCP servers from settings on startup",
				currentValue: config.musepi.mcp.startupDiscovery ? "true" : "false",
				values: ["true", "false"],
			},
			{
				id: "mcp-idle-timeout",
				label: "MCP idle timeout",
				section: "MCP",
				description: "Idle MCP connections are closed after this many ms",
				currentValue: String(config.musepi.mcp.idleTimeoutMs),
				values: TIMEOUT_PRESETS.map(String),
			},
			{
				id: "mcp-servers-info",
				label: "MCP servers (edit file)",
				section: "MCP",
				description: "MCP servers are a nested registry — edit in settings.json",
				currentValue: "open",
				submenu: (_currentValue, done) =>
					new InfoSubmenu(
						"MCP Servers",
						[
							"MCP servers are a nested registry and are edited in settings.json.",
							'Under "musepi.mcp.servers", map a name to a stdio server',
							'{ "command": "...", "args": [...], "env": {...} } or an HTTP server',
							'{ "url": "...", "headers": {...} }. Per-server "enabled": false',
							"disables without deleting. Manage interactively via /mcp.",
							"",
							`Settings file: ${config.musepiSettingsPath}`,
						],
						() => done(),
					),
			},
			{
				id: "lsp-enabled",
				label: "LSP servers",
				section: "LSP",
				description: "Enable Language Server Protocol integration for code intelligence",
				currentValue: config.musepi.lsp.enabled ? "true" : "false",
				values: ["true", "false"],
			},
			{
				id: "lsp-diagnostics",
				label: "LSP diagnostics on write",
				section: "LSP",
				description: "Run LSP diagnostics after every file write/edit",
				currentValue: config.musepi.lsp.diagnosticsOnWrite ? "true" : "false",
				values: ["true", "false"],
			},
			{
				id: "lsp-idle-timeout",
				label: "LSP idle timeout",
				section: "LSP",
				description: "Idle language servers are shut down after this many ms",
				currentValue: String(config.musepi.lsp.idleTimeoutMs),
				values: TIMEOUT_PRESETS.map(String),
			},
			{
				id: "lsp-servers-info",
				label: "LSP servers (edit file)",
				section: "LSP",
				description: "Language-server overrides — edit in settings.json",
				currentValue: "open",
				submenu: (_currentValue, done) =>
					new InfoSubmenu(
						"LSP Server Overrides",
						[
							"Language-server overrides are a nested registry edited in settings.json.",
							'Under "musepi.lsp.servers", map a server name to override fields',
							"(command, args, fileTypes, rootMarkers, isLinter, disabled,",
							"initOptions, settings); fields merge onto the built-in table entry",
							'of the same name, and "disabled": true removes it.',
							"",
							`Settings file: ${config.musepiSettingsPath}`,
						],
						() => done(),
					),
			},
			{
				id: "advanced-settings",
				label: "Advanced MusePi settings",
				section: "Advanced",
				description: "Model roles, memory, notifications, updates, agents, and more",
				currentValue: "configure",
				submenu: (_currentValue, done) =>
					new MusepiSettingsSubmenu(
						config.musepi,
						config.musepiSettingsPath,
						(path, value) => callbacks.onMusepiChange(path, value),
						() => done(),
					),
			},
		];

		// TabBar for tab navigation — 11 tabs matching OMP layout
		this.tabDefs = [
			{ id: "session", label: "Session" },
			{ id: "appearance", label: "Appearance" },
			{ id: "model", label: "Model" },
			{ id: "interaction", label: "Interaction" },
			{ id: "context", label: "Context" },
			{ id: "memory", label: "Memory" },
			{ id: "files", label: "Files" },
			{ id: "shell", label: "Shell" },
			{ id: "tools", label: "Tools" },
			{ id: "tasks", label: "Tasks" },
			{ id: "providers", label: "Providers" },
		];
		this.tabBar = new TabBar("Settings", this.tabDefs, getTabBarTheme());
		this.tabBar.onTabChange = (tab) => this.applyTabFilter(tab.id);
		this.addChild(this.tabBar);

		this.settingsList = new SettingsList(
			items,
			10,
			getSettingsListTheme(),
			(id, newValue) => {
				switch (id) {
					case "autocompact":
						callbacks.onAutoCompactChange(newValue === "true");
						break;
					case "show-images":
						callbacks.onShowImagesChange(newValue === "true");
						break;
					case "image-width-cells":
						callbacks.onImageWidthCellsChange(parseInt(newValue, 10));
						break;
					case "auto-resize-images":
						callbacks.onAutoResizeImagesChange(newValue === "true");
						break;
					case "block-images":
						callbacks.onBlockImagesChange(newValue === "true");
						break;
					case "skill-commands":
						callbacks.onEnableSkillCommandsChange(newValue === "true");
						break;
					case "steering-mode":
						callbacks.onSteeringModeChange(newValue as "all" | "one-at-a-time");
						break;
					case "follow-up-mode":
						callbacks.onFollowUpModeChange(newValue as "all" | "one-at-a-time");
						break;
					case "transport":
						callbacks.onTransportChange(newValue as Transport);
						break;
					case "http-idle-timeout": {
						const choice = HTTP_IDLE_TIMEOUT_CHOICES.find((item) => item.label === newValue);
						if (choice) {
							callbacks.onHttpIdleTimeoutMsChange(choice.timeoutMs);
						}
						break;
					}
					case "hide-thinking":
						callbacks.onHideThinkingBlockChange(newValue === "true");
						break;
					case "cache-miss-notices":
						callbacks.onShowCacheMissNoticesChange(newValue === "true");
						break;
					case "collapse-changelog":
						callbacks.onCollapseChangelogChange(newValue === "true");
						break;
					case "quiet-startup":
						callbacks.onQuietStartupChange(newValue === "true");
						break;
					case "install-telemetry":
						callbacks.onEnableInstallTelemetryChange(newValue === "true");
						break;
					case "default-project-trust": {
						const defaultProjectTrust = DEFAULT_PROJECT_TRUST_BY_LABEL.get(newValue);
						if (defaultProjectTrust) {
							callbacks.onDefaultProjectTrustChange(defaultProjectTrust);
						}
						break;
					}
					case "double-escape-action":
						callbacks.onDoubleEscapeActionChange(newValue as "fork" | "tree");
						break;
					case "tree-filter-mode":
						callbacks.onTreeFilterModeChange(
							newValue as "default" | "no-tools" | "user-only" | "labeled-only" | "all",
						);
						break;
					case "show-hardware-cursor":
						callbacks.onShowHardwareCursorChange(newValue === "true");
						break;
					case "editor-padding":
						callbacks.onEditorPaddingXChange(parseInt(newValue, 10));
						break;
					case "output-padding":
						callbacks.onOutputPadChange(newValue === "0" ? 0 : 1);
						break;
					case "autocomplete-max-visible":
						callbacks.onAutocompleteMaxVisibleChange(parseInt(newValue, 10));
						break;
					case "clear-on-shrink":
						callbacks.onClearOnShrinkChange(newValue === "true");
						break;
					case "terminal-progress":
						callbacks.onShowTerminalProgressChange(newValue === "true");
						break;
					case "theme":
						callbacks.onThemeChange(newValue);
						break;
					case "editor-style":
						callbacks.onMusepiChange("tui.style", newValue);
						break;
					case "model-in-border":
						callbacks.onMusepiChange("tui.modelInBorder", newValue === "true");
						break;
					case "goal-badge":
						callbacks.onMusepiChange("goal.badge", newValue === "true");
						break;
					case "advisor-enabled":
						callbacks.onMusepiChange("advisor.enabled", newValue === "true");
						break;
					case "memory-enabled":
						callbacks.onMusepiChange("memory.enabled", newValue === "true");
						break;
					case "memory-scope":
						callbacks.onMusepiChange("memory.scope", newValue);
						break;
					case "memory-project-cap":
						callbacks.onMusepiChange("memory.caps.project", parseInt(newValue, 10));
						break;
					case "hashline-editing":
						callbacks.onMusepiChange("edit.hashline", newValue === "true");
						break;
					case "enforce-seen-lines":
						callbacks.onMusepiChange("edit.enforceSeenLines", newValue === "true");
						break;
					case "tool-select":
						callbacks.onMusepiChange("toolSelect.enabled", newValue === "true");
						break;
					case "swarm-max-concurrency":
						callbacks.onMusepiChange("swarm.maxConcurrency", parseInt(newValue, 10));
						break;
					case "swarm-timeout-ms":
						callbacks.onMusepiChange("swarm.timeoutMs", parseInt(newValue, 10));
						break;
					case "load-legacy-extensions":
						callbacks.onMusepiChange("compat.loadPiExtensions", newValue === "true");
						break;
					case "mcp-enabled":
						callbacks.onMusepiChange("mcp.enabled", newValue === "true");
						break;
					case "mcp-startup-discovery":
						callbacks.onMusepiChange("mcp.startupDiscovery", newValue === "true");
						break;
					case "web-search-provider": {
						// Map label back to provider id
						const matched = SEARCH_PROVIDER_OPTIONS.find((o) => o.label === newValue);
						if (matched) callbacks.onMusepiChange("providers.webSearch", matched.value);
						break;
					}
					case "lsp-enabled":
						callbacks.onMusepiChange("lsp.enabled", newValue === "true");
						break;
					case "lsp-diagnostics":
						callbacks.onMusepiChange("lsp.diagnosticsOnWrite", newValue === "true");
						break;
					case "mcp-idle-timeout":
						callbacks.onMusepiChange("mcp.idleTimeoutMs", Number(newValue));
						break;
					case "lsp-idle-timeout":
						callbacks.onMusepiChange("lsp.idleTimeoutMs", Number(newValue));
						break;
					case "notifications-enabled":
						callbacks.onMusepiChange("notifications.enabled", newValue === "true");
						break;
					case "swarm-isolation":
						callbacks.onMusepiChange("swarm.isolation", newValue);
						break;
					case "swarm-model-tier":
						// Handled via submenu — no direct switch action needed
						break;
				}
			},
			callbacks.onCancel,
			{ enableSearch: true },
		);

		this.addChild(this.settingsList);

		// Bootstrap: show first tab
		this.tabBar.selectTab("session");
		this.applyTabFilter("session");
	}

	/** Apply tab filter: show all groups under this tab. */
	private applyTabFilter(tabId: string): void {
		const groups = TAB_SECTIONS[tabId];
		if (groups) {
			this.settingsList.setSectionFilter(groups);
		} else {
			// Fallback: filter by tab label (matching section name)
			const tabDef = this.tabDefs.find((t: Tab) => t.id === tabId);
			this.settingsList.setSectionFilter(tabDef?.label ?? null);
		}
	}

	getSettingsList(): SettingsList {
		return this.settingsList;
	}

	// Frame geometry from the last render, for mouse hit-testing (the
	// fullscreen overlay paints from screen row 0, so mouse rows map 1:1).
	private tabRowStart = 0;
	private tabRowCount = 0;
	private contentRowStart = 0;
	private contentRowCount = 0;

	// ── Render (overlay-box framing) ────────────────────────────────

	override render(width: number): string[] {
		const out: string[] = [];
		out.push(topBorder(width, "Settings"));

		const tabLines = this.tabBar.render(width - 4);
		this.tabRowStart = out.length;
		this.tabRowCount = tabLines.length;
		for (const line of tabLines) out.push(row(line, width));
		out.push(divider(width));

		const listLines = this.settingsList.render(width - 4);
		this.contentRowStart = out.length;
		this.contentRowCount = listLines.length;
		for (const line of listLines) out.push(row(line, width));
		out.push(divider(width));

		const footerText = `${rawKeyHint("\u2191/\u2193", "navigate")} \u00B7 Enter toggle \u00B7 / search \u00B7 Esc back`;
		out.push(row(theme.fg("dim", footerText), width));
		out.push(bottomBorder(width));

		return out;
	}

	// ── Input ──────────────────────────────────────────────────────

	handleInput(data: string): void {
		if (this.tabBar.handleInput(data)) return;
		this.settingsList.handleInput(data);
	}

	routeMouse(event: SgrMouseEvent, line: number, _col: number): void {
		const contentColInset = 2;
		const innerCol = event.col - contentColInset;
		const contentLine = line - this.contentRowStart;

		if (event.wheel !== null) {
			if (contentLine >= 0 && contentLine < this.contentRowCount) {
				this.settingsList.handleWheel(event.wheel);
			}
			return;
		}

		if (event.motion) {
			// hover handling could be added here later
			return;
		}

		if (event.leftClick) {
			const tabLine = line - this.tabRowStart;
			if (tabLine >= 0 && tabLine < this.tabRowCount) {
				const tab = this.tabBar.tabAt(tabLine, innerCol);
				if (tab) this.tabBar.selectTab(tab.id);
				return;
			}
			if (contentLine >= 0 && contentLine < this.contentRowCount) {
				const idx = this.settingsList.hitTest(contentLine);
				if (idx >= 0) {
					this.settingsList.selectItemAt(idx);
				}
			}
		}
	}
}
