import { beforeAll, describe, expect, it } from "bun:test";
import { Settings } from "../src/config/settings";
import { registerVisualPrompts, renderVisualAnswers, VISUAL_PROMPT_OWNER } from "../src/plugins/media/visuals/prompts";
import { WidgetTool } from "../src/plugins/media/visuals/tool";
import { WIDGET_RENDER_WHEN } from "../src/plugins/media/visuals/when";
import { PromptHost } from "../src/prompts/host";

/**
 * A visualization the model never calls is dead UI. The "when to render" rule
 * used to exist only in the tool description, so an agent asked for a
 * per-package line breakdown answered with a list and drew the chart only when
 * asked.
 *
 * The guidance now belongs to the `musepi-visuals` plugin, which registers it
 * against the prompt host gated on the `widget` tool. These tests pin the
 * behaviour that matters after that move: the section activates exactly while
 * the tool does, and leaving the plugin takes it away again. They assert what
 * the host assembles and what it releases, not that a particular heading
 * string appears in a joined buffer — a wording check would pass while the
 * section was attributed to the wrong owner, and fail on a harmless reword.
 */

beforeAll(async () => {
	await Settings.init({ inMemory: true });
});

/** Contributions the host holds for the visuals plugin, after assembly. */
function assembled(host: PromptHost, toolNames: string[]): string[] {
	return host.assemble({ activeTools: toolNames }).sections.map(section => section.text ?? "");
}

describe("visual-answer prompt guidance", () => {
	it("registers a section gated on the widget tool", () => {
		const host = new PromptHost();
		const release = registerVisualPrompts(host);

		const withWidget = assembled(host, ["read", "bash", "edit", "write", "widget"]).join("\n");
		expect(withWidget).toContain(WIDGET_RENDER_WHEN);

		const withoutWidget = assembled(host, ["read", "bash", "edit", "write"]).join("\n");
		expect(withoutWidget).not.toContain(WIDGET_RENDER_WHEN);

		release();
		host.close();
	});

	it("ships the same wording the tool description carries", () => {
		// ONE source for the "when to draw" sentence: both channels the model
		// reads interpolate the same constant, so they cannot drift apart.
		expect(new WidgetTool().description).toContain(WIDGET_RENDER_WHEN);
		expect(renderVisualAnswers({} as never)).toContain(WIDGET_RENDER_WHEN);
	});

	it("leaves nothing behind when the plugin is released", () => {
		const host = new PromptHost();
		registerVisualPrompts(host);
		expect(assembled(host, ["widget"]).join("\n")).toContain(WIDGET_RENDER_WHEN);

		host.removeByOwner(VISUAL_PROMPT_OWNER);
		expect(assembled(host, ["widget"]).join("\n")).not.toContain(WIDGET_RENDER_WHEN);

		host.close();
	});

	it("re-registering replaces the previous contribution instead of stacking", () => {
		const host = new PromptHost();
		registerVisualPrompts(host);
		registerVisualPrompts(host);
		const text = assembled(host, ["widget"]).join("\n");
		// A duplicated section would carry the rule twice.
		const occurrences = text.split(WIDGET_RENDER_WHEN).length - 1;
		expect(occurrences).toBe(1);
		host.close();
	});

	it("the prompt.md marker is expanded, never shown to the model", () => {
		const rendered = renderVisualAnswers({} as never);
		expect(rendered).not.toContain("WIDGET_RENDER_WHEN:");
		expect(rendered).not.toContain("<!--");
	});

	it("the rule keeps its anti-abuse limits", () => {
		expect(WIDGET_RENDER_WHEN).toContain("Do not use it for a few numbers");
		expect(WIDGET_RENDER_WHEN).toContain("At most one page per answer");
		expect(WIDGET_RENDER_WHEN).toContain("never restate what the widget already shows");
	});
});
