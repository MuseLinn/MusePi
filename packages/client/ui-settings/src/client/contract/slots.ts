import { defineSlot } from "@musepi/client-ui-slots";

/** Settings page's extension-contributed section. */
export const SETTINGS_EXTENSION_SLOT = defineSlot("settings.extensions");
/** Settings page namespace (`settings.section.<id>`; the only spelling). */
export const SETTINGS_SECTION_SLOT_PREFIX = "settings.section.";
/** Keyed settings card slot. */
export const SETTINGS_ITEM_SLOT_PREFIX = "settings.item.";
