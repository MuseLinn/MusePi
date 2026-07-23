import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Transport } from "@earendil-works/pi-ai";
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
	Spacer,
	Text,
} from "@earendil-works/pi-tui";
import type { ResolvedMusepiSettings } from "@musepi/core";
import { formatHttpIdleTimeoutMs, HTTP_IDLE_TIMEOUT_CHOICES } from "../../../core/http-dispatcher.ts";
import type { DefaultProjectTrust, WarningSettings } from "../../../core/settings-manager.ts";
import {
	getSelectListTheme,
	getSettingsListTheme,
	parseAutoThemeSetting,
	type TerminalTheme,
	theme,
} from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { keyDisplayText } from "./keybinding-hints.ts";
import {
	formatMusepiValue,
	MUSEPI_SETTING_DEFS,
	musepiSettingDescription,
	parseMusepiValue,
} from "./musepi-settings-defs.ts";

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
				label: def.label,
				section: def.section,
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
							`${def.section} · ${def.label}`,
							description,
							currentValue,
							(value) => done(value.length > 0 ? value : "(unset)"),
							() => done(),
						);
					break;
				case "info":
					item.submenu = (_currentValue, done) =>
						new InfoSubmenu(
							`${def.section} · ${def.label}`,
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

/**
 * Main settings selector component.
 */
export class SettingsSelectorComponent extends Container {
	private settingsList: SettingsList;

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
				id: "transport",
				label: "Transport",
				section: "Session",
				description: "Preferred transport for providers that support multiple transports",
				currentValue: config.transport,
				values: ["sse", "websocket", "websocket-cached", "auto"],
			},
			{
				id: "http-idle-timeout",
				label: "HTTP idle timeout",
				section: "Session",
				description:
					"Maximum idle gap while waiting for HTTP headers or body chunks. Disable for local models that pause longer than five minutes.",
				currentValue: formatHttpIdleTimeoutMs(config.httpIdleTimeoutMs),
				values: HTTP_IDLE_TIMEOUT_CHOICES.map((choice) => choice.label),
			},
			{
				id: "thinking",
				label: "Thinking level",
				section: "Session",
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
		];

		// ── Images ───────────────────────────────────────────────────
		// Inline image toggles only when the terminal supports images;
		// auto-resize / block apply to attached and read images either way.
		if (supportsImages) {
			items.push(
				{
					id: "show-images",
					label: "Show images",
					section: "Images",
					description: "Render images inline in terminal",
					currentValue: config.showImages ? "true" : "false",
					values: ["true", "false"],
				},
				{
					id: "image-width-cells",
					label: "Image width",
					section: "Images",
					description: "Preferred inline image width in terminal cells",
					currentValue: String(config.imageWidthCells),
					values: ["60", "80", "120"],
				},
			);
		}
		items.push(
			{
				id: "auto-resize-images",
				label: "Auto-resize images",
				section: "Images",
				description: "Resize large images to 2000x2000 max for better model compatibility",
				currentValue: config.autoResizeImages ? "true" : "false",
				values: ["true", "false"],
			},
			{
				id: "block-images",
				label: "Block images",
				section: "Images",
				description: "Prevent images from being sent to LLM providers",
				currentValue: config.blockImages ? "true" : "false",
				values: ["true", "false"],
			},
		);

		// ── Interface ────────────────────────────────────────────────
		items.push(
			{
				id: "theme",
				label: "Theme",
				section: "Interface",
				description: "Color theme for the interface",
				currentValue: config.currentTheme,
				submenu: (currentValue, done) =>
					new ThemeSubmenu(currentValue, config.terminalTheme, config.availableThemes, callbacks, done),
			},
			{
				id: "hide-thinking",
				label: "Hide thinking",
				section: "Interface",
				description: "Hide thinking blocks in assistant responses",
				currentValue: config.hideThinkingBlock ? "true" : "false",
				values: ["true", "false"],
			},
			{
				id: "cache-miss-notices",
				label: "Cache miss notices",
				section: "Interface",
				description: "Show transcript notices for significant prompt-cache misses",
				currentValue: config.showCacheMissNotices ? "true" : "false",
				values: ["true", "false"],
			},
			{
				id: "collapse-changelog",
				label: "Collapse changelog",
				section: "Interface",
				description: "Show condensed changelog after updates",
				currentValue: config.collapseChangelog ? "true" : "false",
				values: ["true", "false"],
			},
			{
				id: "quiet-startup",
				label: "Quiet startup",
				section: "Interface",
				description: "Disable verbose printing at startup",
				currentValue: config.quietStartup ? "true" : "false",
				values: ["true", "false"],
			},
			{
				id: "show-hardware-cursor",
				label: "Show hardware cursor",
				section: "Interface",
				description: "Show the terminal cursor while still positioning it for IME support",
				currentValue: config.showHardwareCursor ? "true" : "false",
				values: ["true", "false"],
			},
			{
				id: "editor-padding",
				label: "Editor padding",
				section: "Interface",
				description: "Horizontal padding for input editor (0-3)",
				currentValue: String(config.editorPaddingX),
				values: ["0", "1", "2", "3"],
			},
			{
				id: "output-padding",
				label: "Output padding",
				section: "Interface",
				description: "Horizontal padding for user messages, assistant messages, and thinking",
				currentValue: String(config.outputPad),
				values: ["0", "1"],
			},
			{
				id: "autocomplete-max-visible",
				label: "Autocomplete max items",
				section: "Interface",
				description: "Max visible items in autocomplete dropdown (3-20)",
				currentValue: String(config.autocompleteMaxVisible),
				values: ["3", "5", "7", "10", "15", "20"],
			},
			{
				id: "clear-on-shrink",
				label: "Clear on shrink",
				section: "Interface",
				description: "Clear empty rows when content shrinks (may cause flicker)",
				currentValue: config.clearOnShrink ? "true" : "false",
				values: ["true", "false"],
			},
			{
				id: "terminal-progress",
				label: "Terminal progress",
				section: "Interface",
				description: "Show OSC 9;4 progress indicators in the terminal tab bar",
				currentValue: config.showTerminalProgress ? "true" : "false",
				values: ["true", "false"],
			},
		);

		// ── Advanced ─────────────────────────────────────────────────
		items.push(
			{
				id: "skill-commands",
				label: "Skill commands",
				section: "Advanced",
				description: "Register skills as /skill:name commands",
				currentValue: config.enableSkillCommands ? "true" : "false",
				values: ["true", "false"],
			},
			{
				id: "double-escape-action",
				label: "Double-escape action",
				section: "Advanced",
				description: "Action when pressing Escape twice with empty editor",
				currentValue: config.doubleEscapeAction,
				values: ["tree", "fork", "none"],
			},
			{
				id: "tree-filter-mode",
				label: "Tree filter mode",
				section: "Advanced",
				description: "Default filter when opening /tree",
				currentValue: config.treeFilterMode,
				values: ["default", "no-tools", "user-only", "labeled-only", "all"],
			},
			{
				id: "install-telemetry",
				label: "Install telemetry",
				section: "Advanced",
				description: "Send an anonymous version/update ping after changelog-detected updates",
				currentValue: config.enableInstallTelemetry ? "true" : "false",
				values: ["true", "false"],
			},
		);

		// ── MusePi ───────────────────────────────────────────────────
		items.push({
			id: "musepi",
			label: "MusePi settings",
			section: "MusePi",
			description:
				"MusePi feature settings: memory, MCP, LSP, advisor, model roles, tool select, swarm, and more. Most changes apply to new sessions.",
			currentValue: "configure",
			submenu: (_currentValue, done) =>
				new MusepiSettingsSubmenu(
					config.musepi,
					config.musepiSettingsPath,
					(path, value) => callbacks.onMusepiChange(path, value),
					() => done(),
				),
		});

		// Add borders
		this.addChild(new DynamicBorder());

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
				}
			},
			callbacks.onCancel,
			{ enableSearch: true },
		);

		this.addChild(this.settingsList);
		this.addChild(new DynamicBorder());
	}

	getSettingsList(): SettingsList {
		return this.settingsList;
	}
}
