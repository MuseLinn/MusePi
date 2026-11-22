import { defineSlot } from "@musepi/client-ui-slots";

/** Full welcome and session surface slot (root `main` key `conversation`). */
export const CONVERSATION_SLOT = defineSlot("main.conversation");
/** Full capability-center page slot (root `main` key `capability`). */
export const CAPABILITY_CENTER_SLOT = defineSlot("main.capability");
/** Window-level overlay layer (floating scroll rail); host keeps a fallback. */
export const SHELL_OVERLAY_SLOT = defineSlot("shell.overlay");
/** Full right-panel shell, independently replaceable from main.conversation. */
export const PANEL_SHELL_SLOT = defineSlot("panel.shell");
/** Always-mounted managed browser guest host. */
export const BROWSER_HOST_SLOT = defineSlot("browser.host");
/** Right-side workspace panel slot. */
export const RIGHT_PANEL_SLOT = defineSlot("panel.right");
/** Right-edge 44px icon rail slot. */
export const RIGHT_RAIL_SLOT = defineSlot("rail.right");
/** Open namespace: the prefix decides where the panel tab mounts. */
export const PANEL_TAB_SLOT_PREFIX = "panel.tab.";
export const RAIL_SLOT_PREFIX = "rail.";
