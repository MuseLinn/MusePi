import "./happy-dom-shim"; // MUST be first: client-core defines HTMLElement subclasses at evaluation time.
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Tour-overlay hierarchy contract (2026-11-24).
 *
 * The primer and the what's-new panel are the same L3 tour surface: one
 * scrim, one card shell, one enter/exit ladder. The what's-new card had
 * drifted on four axes — it painted an opaque fill (killing the glass on
 * macOS while the win32/Linux fallback re-added it), set a smaller heading,
 * swapped the borderless close button for a bordered one, and left its
 * footer left-aligned with no way to tell the primary action apart.
 *
 * These assertions pin the shared hierarchy so the two cards cannot drift
 * apart again without a visible failure here.
 */

const REPO_ROOT = path.resolve(import.meta.dir, "../../..");
const read = (rel: string): string => fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");

const WIDGETS = "apps/desktop/src/styles/gui-widgets.css";
const ANNOUNCEMENT_TSX = "apps/desktop/src/components/AnnouncementOverlay.tsx";
const ONBOARDING_TSX = "apps/desktop/src/components/OnboardingOverlay.tsx";

/** Extract a declaration body from a selector block (single-level braces). */
function rule(css: string, selector: string): string | null {
	const at = css.indexOf(`${selector} {`);
	if (at < 0) return null;
	const open = css.indexOf("{", at);
	const close = css.indexOf("}", open);
	return open < 0 || close < 0 ? null : css.slice(open + 1, close);
}

function declaration(body: string, name: string): string {
	const match = new RegExp(`(?:^|[;{\\s])${name}\\s*:\\s*([^;]+);`).exec(body);
	return match?.[1]?.trim() ?? "";
}

describe("both tour cards paint the same L3 glass", () => {
	test("the what's-new card keeps the sheen and the translucent strong fill", () => {
		const body = rule(read(WIDGETS), ".gui-announcement-card");
		expect(body, "no .gui-announcement-card block").not.toBeNull();
		const background = declaration(body!, "background");
		expect(background).toContain("var(--glass-sheen)");
		expect(background).toContain("var(--glass-bg-strong)");
		// An opaque fill would erase the glass on macOS only: the platform
		// fallback in overlay-fallback.css re-adds sheen on win32/Linux.
		expect(background).not.toContain("var(--bg-raised)");
		expect(declaration(body!, "background-color")).toBe("");
	});

	test("the what's-new heading uses the primer's heading step", () => {
		const css = read(WIDGETS);
		const primer = rule(css, ".gui-onboarding-title");
		const title = rule(css, ".gui-announcement-title");
		const heading = rule(css, ".gui-announcement-heading");
		for (const [name, body] of [
			[".gui-onboarding-title", primer],
			[".gui-announcement-title", title],
			[".gui-announcement-heading", heading],
		] as const) {
			expect(body, `no ${name} block`).not.toBeNull();
			expect(declaration(body!, "font-size"), `${name} heading step`).toBe("20px");
			expect(declaration(body!, "font-weight"), `${name} heading weight`).toBe("650");
		}
	});

	test("the announcement footer is a right-aligned dialog footer", () => {
		const body = rule(read(WIDGETS), ".gui-announcement-card .gui-onboarding-actions");
		expect(body, "no announcement footer block").not.toBeNull();
		expect(declaration(body!, "justify-content")).toBe("flex-end");
		expect(declaration(body!, "border-top")).toContain("var(--border)");
	});
});

describe("both tour cards share one close affordance and one motion switch", () => {
	test("the announcement uses the primer's borderless close button", () => {
		const tsx = read(ANNOUNCEMENT_TSX);
		expect(tsx).toContain('className="gui-onboarding-close"');
		// The bordered .gui-btn-icon close read as a different control family
		// than the primer's at the same corner.
		expect(tsx).not.toContain('className="gui-btn gui-btn-icon"');
	});

	test("the in-app motion switch stops the two persistent pulses", () => {
		const css = read(WIDGETS);
		// The current-step dot and the latest-version pill loop forever.
		// prefers-reduced-motion collapses them through the global 0.01ms
		// rule; the motion toggle only matches selectors listed here.
		expect(css).toContain(".gui-motion-off .gui-onboarding-dot--active");
		expect(css).toContain(".gui-motion-off .gui-announcement-latest");
	});

	test("the primer's step body feathers its scroll edges", () => {
		// The what's-new body already scrolls inside FadeScroll; the primer's
		// bare overflow-y container was the one unfeathered scroller left in
		// the tour family (gui-dialog-spec §4).
		const tsx = read(ONBOARDING_TSX);
		expect(tsx).toContain('<FadeScroll className="gui-obo-step-body">');
		expect(tsx).not.toContain('<div className="gui-obo-step-body">');
	});
});

describe("the appearance step exposes every theme axis", () => {
	test("the primer offers the palette axis, not just light/dark", () => {
		// Scheme (dark/light/system) and palette (the ui-themes) are separate
		// axes in the product: collapsing them left the primer unable to pick
		// any of the 18 presets the settings page offers.
		const tsx = read(ONBOARDING_TSX);
		expect(tsx).toContain("UNIFIED_THEME_PRESETS");
		expect(tsx).toContain("setLightTheme");
		expect(tsx).toContain("setDarkTheme");
		expect(tsx).toContain('className="gui-obo-palette-select"');
	});

	test("the primer and the settings page read one preset label table", () => {
		const labels = read("apps/desktop/src/lib/theme-preset-labels.ts");
		expect(labels).toContain("THEME_PRESET_LABEL");
		// Both surfaces import the shared table instead of keeping a copy.
		for (const file of [ONBOARDING_TSX, "apps/desktop/src/components/settings-sections/appearance.tsx"]) {
			expect(read(file), `${file} must use the shared label table`).toContain("THEME_PRESET_LABEL");
		}
	});

	test("a scheme-only preset stays selectable instead of rendering a raw id", () => {
		// midnight is dark-only and warm is light-only; neither is in the
		// unified list, so the trigger appends the current pick rather than
		// showing an untranslated id.
		const tsx = read(ONBOARDING_TSX);
		expect(tsx).toContain("paletteOptions");
		expect(tsx).toContain("...UNIFIED_THEME_PRESETS, { id: schemePalette, label: schemePalette }");
	});
});

describe("the primer header shares its row with the icon", () => {
	test("the icon and the heading sit in one flex row", () => {
		const tsx = read(ONBOARDING_TSX);
		expect(tsx).toContain('className="gui-onboarding-head"');
		expect(tsx).toContain('className="gui-onboarding-head-copy"');
		const css = read(WIDGETS);
		const head = rule(css, ".gui-onboarding-head");
		expect(head, "no .gui-onboarding-head block").not.toBeNull();
		expect(declaration(head!, "display")).toBe("flex");
		// The title no longer pushes itself down off the icon's baseline.
		expect(declaration(rule(css, ".gui-onboarding-title")!, "margin-top")).toBe("0");
	});
});

describe("primer controls answer the pointer and the keyboard", () => {
	test("the shared button carries press and focus states", () => {
		// base.css drops the global :focus-visible ring, so every control that
		// wants one has to declare it. Without :active a click reads as a no-op
		// until the handler's effect lands.
		const css = read("apps/desktop/src/styles/gui-composer.css");
		const body = rule(css, ".gui-btn");
		expect(body, "no .gui-btn block").not.toBeNull();
		expect(declaration(body!, "transition")).toContain("transform");
		expect(css).toContain(".gui-btn:active:not(:disabled)");
		expect(css).toContain(".gui-btn:focus-visible");
		const focus = rule(css, ".gui-btn:focus-visible");
		expect(declaration(focus!, "outline")).toContain("var(--color-accent)");
	});

	test("the close button and the segmented tabs answer the pointer too", () => {
		const css = read(WIDGETS);
		for (const selector of [".gui-onboarding-close", ".gui-obo-tab", ".gui-obo-branch-head"]) {
			expect(css, `${selector} has no :active state`).toContain(`${selector}:active`);
		}
	});

	test("appearance chips press in place instead of only lifting", () => {
		const css = read("apps/desktop/src/styles/gui-misc.css");
		expect(css).toContain(".gui-obo-appearance-card:active");
		expect(css).toContain(".gui-obo-appearance-card:focus-visible");
	});
});

describe("the voice step reads as icon, copy, action", () => {
	test("the action keeps its own column so its label can change", () => {
		const css = read("apps/desktop/src/styles/gui-misc.css");
		const card = rule(css, ".gui-obo-voice-check");
		expect(card, "no .gui-obo-voice-check block").not.toBeNull();
		// icon | copy | action — a two-column card put the button under the
		// status text, so its position drifted with the copy length.
		expect(declaration(card!, "grid-template-columns")).toBe("32px minmax(0, 1fr) auto");
		const button = rule(css, ".gui-obo-voice-check > .gui-btn");
		expect(declaration(button!, "grid-column")).toBe("3");
		expect(declaration(button!, "justify-self")).toBe("end");
	});

	test("the status tile carries the outcome colour, not only the border", () => {
		const css = read("apps/desktop/src/styles/gui-misc.css");
		// Reading the glyph is the first thing a person does; a green or red
		// tile states the outcome without parsing the status sentence.
		expect(css).toContain('.gui-obo-voice-check[data-state="ready"] .gui-obo-voice-check-icon');
		expect(css).toContain('.gui-obo-voice-check[data-state="error"] .gui-obo-voice-check-icon');
	});
});

describe("the provider preview mirrors the real list", () => {
	test("the demo rows reuse the list's own row parts, not skeleton bars", () => {
		const tsx = read(ONBOARDING_TSX);
		// The preview used to draw dots + grey bars, which read as a wireframe
		// rather than the list the left pane shows.
		expect(tsx).not.toContain("gui-obo-provider-skel");
		expect(tsx).not.toContain("gui-obo-provider-dot");
		expect(tsx).toContain("<ModelBrandIcon provider={row.id}");
		expect(tsx).toContain('className="gui-obo-provider-status"');
		expect(tsx).toContain('className="gui-obo-demo-search"');
	});
});

describe("the voice step reuses the shared voice controls", () => {
	test("the microphone card is the settings device picker, not a probe button", () => {
		const tsx = read("apps/desktop/src/components/OnboardingVoiceSetup.tsx");
		expect(tsx).toContain("<VoiceInputDevicePicker active />");
		// The picker opens the device and reports permission itself; a manual
		// "Check microphone" button would be the second detection path §5n bans.
		expect(tsx).not.toContain("probeMicrophone");
		expect(tsx).not.toContain("Check microphone");
	});

	test("the voiceprint card opens the shared enrollment dialog", () => {
		const tsx = read("apps/desktop/src/components/OnboardingVoiceSetup.tsx");
		expect(tsx).toContain("<SpeakerEnrollment");
		expect(tsx).toContain('"voice.speakerStatus"');
		expect(tsx).toContain('tLoose("Enroll voice")');
	});
});

describe("conditional blocks in the primer use the shared Reveal", () => {
	test("the inline login panel grows instead of jumping", () => {
		const tsx = read(ONBOARDING_TSX);
		expect(tsx).toContain("<Reveal open={Boolean(loginState)}>");
	});
});

describe("the primer keeps one vertical rhythm across steps", () => {
	test("every step's content starts at the same gap under the heading", () => {
		const widgets = read(WIDGETS);
		const misc = read("apps/desktop/src/styles/gui-misc.css");
		// A step that starts 14px higher than its neighbours makes the card
		// jump when the spine advances.
		for (const [name, body] of [
			[".gui-obo-appearance", rule(misc, ".gui-obo-appearance")],
			[".gui-obo-provider-form", rule(widgets, ".gui-obo-provider-form")],
			[".gui-obo-voice-setup", rule(misc, ".gui-obo-voice-setup")],
			[".gui-obo-branches", rule(widgets, ".gui-obo-branches")],
		] as const) {
			expect(body, `no ${name} block`).not.toBeNull();
			expect(declaration(body!, "margin-top"), `${name} heading gap`).toBe("14px");
		}
	});

	test("the open branch reads as the active container", () => {
		const css = read(WIDGETS);
		// Five identical collapsed cards gave no clue which one was open.
		expect(css).toContain('.gui-obo-branch:has(> .gui-obo-branch-head[aria-expanded="true"])');
	});

	test("the six accent chips keep one line each", () => {
		// The full "自定义强调色" wrapped to two lines and made that chip taller
		// than its neighbours — same control, different weight.
		const tsx = read(ONBOARDING_TSX);
		expect(tsx).toContain('{ id: "custom", key: "settings.customAccentShort" }');
	});
});

describe("the announcement keyboard contract lets links open", () => {
	test("Enter on a focused link does not dismiss the panel", () => {
		const tsx = read(ANNOUNCEMENT_TSX);
		expect(tsx).toContain("e.target instanceof HTMLAnchorElement");
	});
});
