import { initTooltips as initSharedTooltips } from "@musepi/client-core";
import { shellPlatform } from "./electron";

export function initTooltips(): void {
	document.documentElement.dataset.platform = shellPlatform();
	initSharedTooltips();
}
