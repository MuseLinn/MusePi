import { useModalFocus } from "@musepi/client-core";
import type { RefObject } from "react";

/** Trap keyboard focus within the ref'd element while `active` is true. */
export function useFocusTrap<T extends HTMLElement = HTMLElement>(active: boolean): RefObject<T | null> {
	return useModalFocus<T>(active);
}
