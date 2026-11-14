import "./happy-dom-shim";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { getLocaleSnapshot, setLocale } from "@musepi/client-core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { OnboardingOverlay } from "../src/components/OnboardingOverlay";
import { DONE_KEY } from "../src/lib/onboarding";
import { SESSION_TABS_CHANGED_EVENT, SESSION_TABS_ENABLED_KEY } from "../src/lib/session-tabs";

let root: Root;
let host: HTMLDivElement;
let previousLocale: ReturnType<typeof getLocaleSnapshot>;

beforeEach(() => {
	previousLocale = getLocaleSnapshot();
	setLocale("en-US");
	localStorage.clear();
	host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
});

afterEach(() => {
	act(() => root.unmount());
	host.remove();
	localStorage.clear();
	setLocale(previousLocale);
});

function mountOnboarding(step?: number): void {
	act(() => {
		root.render(<OnboardingOverlay rpc={null} providerEvent={null} />);
	});
	if (step !== undefined) {
		act(() => {
			window.dispatchEvent(new CustomEvent("musepi-open-onboarding", { detail: { step } }));
		});
	}
}

function showSessionTabsStep(): void {
	for (let i = 0; i < 2; i++) {
		act(() => {
			host.querySelector<HTMLButtonElement>(".gui-onboarding-next")?.click();
		});
	}
}

function closeOnboarding(): void {
	act(() => {
		host.querySelector<HTMLButtonElement>(".gui-onboarding-close")?.click();
	});
}

describe("onboarding session tabs preference", () => {
	test("first launch recommends tabs and closing accepts the recommendation", () => {
		mountOnboarding();
		showSessionTabsStep();

		expect(host.querySelector('[role="switch"]')?.getAttribute("aria-checked")).toBe("true");
		expect(host.querySelector(".gui-obo-session-tabs")).not.toBeNull();
		closeOnboarding();

		expect(localStorage.getItem(SESSION_TABS_ENABLED_KEY)).toBe("1");
		expect(localStorage.getItem(DONE_KEY)).toBe("1");
	});

	test("an explicit off choice wins over the first-launch recommendation", () => {
		localStorage.setItem(SESSION_TABS_ENABLED_KEY, "0");
		mountOnboarding();
		showSessionTabsStep();

		expect(host.querySelector('[role="switch"]')?.getAttribute("aria-checked")).toBe("false");
		closeOnboarding();

		expect(localStorage.getItem(SESSION_TABS_ENABLED_KEY)).toBe("0");
	});

	test("the switch updates the shared preference and preview, then survives a manual replay", () => {
		localStorage.setItem(SESSION_TABS_ENABLED_KEY, "1");
		mountOnboarding(2);
		let changes = 0;
		const onChange = (): void => {
			changes += 1;
		};
		window.addEventListener(SESSION_TABS_CHANGED_EVENT, onChange);
		try {
			act(() => {
				host.querySelector<HTMLButtonElement>('[role="switch"]')?.click();
			});

			expect(localStorage.getItem(SESSION_TABS_ENABLED_KEY)).toBe("0");
			expect(changes).toBe(1);
			expect(host.querySelector('[role="switch"]')?.getAttribute("aria-checked")).toBe("false");
			expect(host.querySelector(".gui-obo-session-tabs")).toBeNull();
			closeOnboarding();

			act(() => {
				window.dispatchEvent(new CustomEvent("musepi-open-onboarding", { detail: { step: 2 } }));
			});
			expect(host.querySelector('[role="switch"]')?.getAttribute("aria-checked")).toBe("false");
		} finally {
			window.removeEventListener(SESSION_TABS_CHANGED_EVENT, onChange);
		}
	});
});
