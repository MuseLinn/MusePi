import { Container, getKeybindings, Spacer, Text } from "@musepi/pi-tui";
import { t } from "../../../../../musepi/core/src/i18n/index.ts";
import { renderThemePreview, setColorBlindMode, setTheme, theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { keyHint, rawKeyHint } from "./keybinding-hints.ts";

export interface FirstTimeSetupResult {
	theme: string;
}

export interface FirstTimeSetupOptions {
	detectedTheme: string;
	onThemePreview: (themeName: string) => void;
	onSubmit: (result: FirstTimeSetupResult) => void;
	onCancel: () => void;
}

interface CuratedTheme {
	value: string;
	label: string;
	description: string;
}

const CURATED_THEMES: CuratedTheme[] = [
	{
		value: "auto",
		label: "Match terminal",
		description: "Auto-switches between dark and light based on terminal appearance",
	},
	{ value: "dark", label: "Dark", description: "Default dark theme with blue accents" },
	{ value: "light", label: "Light", description: "Clean light theme for bright terminals" },
	{ value: "nord", label: "Nord", description: "Arctic-inspired cold blue palette" },
	{ value: "gruvbox", label: "Gruvbox", description: "Warm retro sepia palette" },
	{ value: "tokyo-night", label: "Tokyo Night", description: "Deep blue-violet urban night" },
	{ value: "catppuccin", label: "Catppuccin", description: "Soft pastel with warm undertones" },
	{
		value: "colorblind",
		label: "Colorblind-friendly",
		description: "Adjust greens toward blue for red-green colorblindness",
	},
];

const SETUP_LOGO_LINES = ["██████", "██  ██", "████  ██", "██    ██"];

/** First-time setup dialog: curated theme choice with live preview. */
export class FirstTimeSetupComponent extends Container {
	private themeIndex: number;
	private readonly options: FirstTimeSetupOptions;
	private themePreviewLines: string[] = [];

	constructor(options: FirstTimeSetupOptions) {
		super();
		this.options = options;
		this.themeIndex = Math.max(
			0,
			CURATED_THEMES.findIndex((t) => t.value === options.detectedTheme || t.value === "dark"),
		);
		this.refreshThemePreview();
		this.update();
	}

	// Rebuild the whole dialog on every change so theme previews recolor all text.
	private update(): void {
		this.clear();
		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("accent", SETUP_LOGO_LINES.join("\n")), 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("accent", theme.bold(t("Welcome to MusePi, the AI coding agent."))), 1, 0));
		this.addChild(new Spacer(1));

		this.addChild(new Text(theme.fg("text", t("Pick a theme. Navigate with arrow keys to preview.")), 1, 0));
		this.addChild(new Text(theme.fg("muted", `${t("Detected appearance")}: ${this.options.detectedTheme}`), 1, 0));
		this.addChild(new Spacer(1));
		this.renderThemeList();
		// Live preview strip
		if (this.themePreviewLines.length > 0) {
			this.addChild(new Spacer(1));
			for (const line of this.themePreviewLines) {
				this.addChild(new Text(line, 1, 0));
			}
		}

		this.addChild(new Spacer(1));
		this.addChild(
			new Text(
				rawKeyHint("↑↓", "navigate") +
					"  " +
					keyHint("tui.select.confirm", "finish") +
					"  " +
					keyHint("tui.select.cancel", "skip setup"),
				1,
				0,
			),
		);
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());
	}

	private renderThemeList(): void {
		for (let i = 0; i < CURATED_THEMES.length; i++) {
			const item = CURATED_THEMES[i];
			const isSelected = i === this.themeIndex;
			const prefix = isSelected ? theme.fg("accent", "→ ") : "  ";
			const label = isSelected ? theme.fg("accent", theme.bold(item.label)) : theme.fg("text", item.label);
			const desc = isSelected ? theme.fg("dim", `  ${item.description}`) : "";
			this.addChild(new Text(`${prefix}${label}${desc}`, 1, 0));
		}
	}

	private refreshThemePreview(): void {
		try {
			const preview = renderThemePreview(theme);
			// Split into lines of max width 60
			const lineLength = 60;
			const chips = preview;
			const lines: string[] = [];
			for (let i = 0; i < chips.length; i += lineLength) {
				lines.push(chips.slice(i, i + lineLength));
			}
			this.themePreviewLines = lines.length > 0 ? lines : [];
		} catch {
			this.themePreviewLines = [];
		}
	}

	private moveSelection(delta: number): void {
		const next = Math.max(0, Math.min(CURATED_THEMES.length - 1, this.themeIndex + delta));
		if (next !== this.themeIndex) {
			this.themeIndex = next;
			const selected = CURATED_THEMES[this.themeIndex];
			if (selected.value === "colorblind") {
				setColorBlindMode(true);
				setTheme("dark");
			} else {
				setColorBlindMode(false);
				setTheme(selected.value);
			}
			this.refreshThemePreview();
			this.options.onThemePreview(selected.value);
		}
		this.update();
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		if (kb.matches(keyData, "tui.select.up") || keyData === "k") {
			this.moveSelection(-1);
		} else if (kb.matches(keyData, "tui.select.down") || keyData === "j") {
			this.moveSelection(1);
		} else if (kb.matches(keyData, "tui.select.confirm") || keyData === "\n") {
			const selected = CURATED_THEMES[this.themeIndex];
			this.options.onSubmit({ theme: selected.value });
		} else if (kb.matches(keyData, "tui.select.cancel")) {
			this.options.onCancel();
		}
	}
}
