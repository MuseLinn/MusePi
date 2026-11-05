/**
 * Section ids shared by the session info card's 「管理集成」 entry and the
 * settings shell. `INTEGRATIONS_SECTION` is the name the host's `openSettings`
 * accepts; `INTEGRATIONS_SETTINGS_SECTION` is the nav id SettingsView resolves
 * it to once the plugin-contributed tab is known.
 */
export const INTEGRATIONS_SECTION = "integrations";

/** Nav id `SettingsNav.navGroups` assigns to the `settings.tab.integrations` slot. */
export const INTEGRATIONS_SETTINGS_SECTION = "ext:settings.tab.integrations";
