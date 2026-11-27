import type { ReactNode } from "react";
import { NotificationCenter } from "../../src/components/NotificationCenter";
import {
	clearNotificationHistory,
	recordNotificationHistory,
} from "@musepi/client-core/src/lib/notification-history";
import type { GuiScenario } from "../gui-probe-helpers";
import { mount, readElement, sleep } from "../gui-probe-helpers";

function seed(count: number): void {
	clearNotificationHistory();
	for (let id = 0; id < count; id++) {
		recordNotificationHistory({
			id,
			kind: id % 4 === 0 ? "success" : id % 4 === 1 ? "warning" : id % 4 === 2 ? "error" : "info",
			title: id === count - 1 ? "Session update" : undefined,
			message: `Notification message ${id + 1}`,
			createdAt: Date.now() - id * 60_000,
		});
	}
}

const frame = (): ReactNode => (
	<div className="gui-chat-col" style={{ width: 640, height: 120 }}>
		<header className="gui-header flex h-12 flex-shrink-0 items-center gap-2 px-4">
			<div className="gui-header-title">MusePi</div>
			<div className="ml-auto flex shrink-0 items-center gap-1">
				<NotificationCenter />
			</div>
		</header>
	</div>
);

async function renderCount(root: HTMLElement, count: number): Promise<void> {
	seed(count);
	await mount(frame(), root);
}

async function openPanel(): Promise<void> {
	document.querySelector<HTMLButtonElement>(".gui-notification-trigger")?.click();
	await sleep(200);
}

function measurements(body: ParentNode): Record<string, unknown> {
	const center = body.querySelector<HTMLElement>(".gui-notification-center");
	const centerStyle = center ? getComputedStyle(center) : null;
	const rect = center?.getBoundingClientRect();
	const hit = rect ? document.elementFromPoint(rect.left + 24, rect.top + 24) : null;
	return {
		elements: {
			trigger: readElement(body.querySelector(".gui-notification-trigger")),
			badge: readElement(body.querySelector(".gui-notification-badge")),
			center: readElement(body.querySelector(".gui-notification-center")),
			panelBody: readElement(body.querySelector("#gui-notification-center")),
			heading: readElement(body.querySelector(".gui-notification-head strong")),
			empty: readElement(body.querySelector(".gui-notification-empty")),
			firstRow: readElement(body.querySelector(".gui-notification-row")),
		},
		rowCount: body.querySelectorAll(".gui-notification-row").length,
		centerState: centerStyle
			? {
					visibility: centerStyle.visibility,
					transform: centerStyle.transform,
					zIndex: centerStyle.zIndex,
					clipPath: centerStyle.clipPath,
					hit: hit instanceof Element ? `${hit.tagName}.${hit.className}` : null,
				}
			: null,
	};
}

const scenarios = {
	"notifications-zero": {
		capture: ".gui-header",
		async render(root: HTMLElement) {
			await renderCount(root, 0);
		},
		async measure(body: ParentNode) {
			return measurements(body);
		},
	},
	"notifications-three": {
		capture: ".gui-header",
		async render(root: HTMLElement) {
			await renderCount(root, 3);
		},
		async measure(body: ParentNode) {
			return measurements(body);
		},
	},
	"notifications-99-plus": {
		capture: ".gui-header",
		async render(root: HTMLElement) {
			await renderCount(root, 105);
		},
		async measure(body: ParentNode) {
			return measurements(body);
		},
	},
	"notifications-empty-panel": {
		capture: ".gui-notification-center",
		async render(root: HTMLElement) {
			await renderCount(root, 0);
			await openPanel();
		},
		async measure(body: ParentNode) {
			return measurements(body);
		},
	},
	"notifications-populated-panel": {
		capture: ".gui-notification-center",
		async render(root: HTMLElement) {
			await renderCount(root, 4);
			await openPanel();
		},
		async measure(body: ParentNode) {
			return measurements(body);
		},
	},
} satisfies Record<string, GuiScenario>;

export default scenarios;
