import type { TranslationKey, UiThemeId } from "@musepi/client-core";

/** i18n key per ui-theme preset — the one label table for every surface that
 *  names a palette (settings appearance page, first-run primer). */
export const THEME_PRESET_LABEL: Record<UiThemeId, TranslationKey> = {
	default: "settings.themePresetDefault",
	warm: "settings.themePresetWarm",
	cool: "settings.themePresetCool",
	midnight: "settings.themePresetMidnight",
	graphite: "settings.themePresetGraphite",
	anthro: "settings.themePresetAnthro",
	openchamber: "settings.themePresetOpenchamber",
	catppuccin: "settings.themePresetCatppuccin",
	nord: "settings.themePresetNord",
	tokyonight: "settings.themePresetTokyonight",
	aura: "settings.themePresetAura",
	ayu: "settings.themePresetAyu",
	dracula: "settings.themePresetDracula",
	gruvbox: "settings.themePresetGruvbox",
	kanagawa: "settings.themePresetKanagawa",
	monokai: "settings.themePresetMonokai",
	solarized: "settings.themePresetSolarized",
	vesper: "settings.themePresetVesper",
};
