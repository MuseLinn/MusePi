import { defineSlot } from "@musepi/client-ui-slots";

/** Settings page's extension-contributed section. */
export const SETTINGS_EXTENSION_SLOT = defineSlot("settings.extensions");
/** One settings page entry (`settings.section`). The registrant supplies the
 *  owner options: `id`, `label`, `icon`, `order` and `keywords`. */
export const SETTINGS_SECTION_SLOT = defineSlot("settings.section");
/** Keyed settings card / page-row slot namespace. */
export const SETTINGS_ITEM_SLOT_PREFIX = "settings.item.";
