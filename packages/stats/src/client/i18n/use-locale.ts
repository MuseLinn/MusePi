import { useSyncExternalStore } from "react";
import { getLocaleSnapshot, subscribeLocale } from "./index";

/** Current locale string: "zh-CN" or "en-US". Re-renders on locale change. */
export function useLocale(): string {
	return useSyncExternalStore(subscribeLocale, getLocaleSnapshot, () => "en-US");
}
