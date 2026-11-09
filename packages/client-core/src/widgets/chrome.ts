import { createContext } from "react";

/**
 * DOM slot inside a widget card's head where a face can portal its own action.
 *
 * The annotation entry belongs with the card's other actions (copy, menu,
 * fullscreen), not on a second row of its own. A face that needs a head action
 * reads this context and portals into it; outside a card (board canvas, HTML
 * export) the value is null and the face falls back to its inline row.
 */
export const WidgetHeadActionsSlot = createContext<HTMLElement | null>(null);
