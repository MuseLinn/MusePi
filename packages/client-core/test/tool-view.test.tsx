import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ToolCard } from "../src/components/transcript/ToolCard";
import { t } from "../src/i18n/index.js";
import { registerExternalToolRenderers } from "../src/tool-render/registry";
import { ToolView } from "../src/tool-render/ToolView";

describe("ToolView xd:// dispatches", () => {
	it("renders successful execute-mode xdev writes as the inner generate_image tool", () => {
		const html = renderToStaticMarkup(
			<ToolView
				name="write"
				defaultOpen
				result={{
					content: [],
					details: {
						xdev: {
							tool: "generate_image",
							mode: "execute",
							args: { subject: "alpine lake" },
							inner: {
								images: [{ data: "aW1hZ2U=", mimeType: "image/png" }],
							},
						},
					},
				}}
			/>,
		);

		expect(html).toContain(t("tools.toolGenerateImage"));
		expect(html).toContain("alpine lake");
		expect(html).toContain('src="data:image/png;base64,aW1hZ2U="');
	});

	it("renders xd://resolve apply cards from unwrapped inner details", () => {
		const html = renderToStaticMarkup(
			<ToolView
				name="write"
				defaultOpen
				result={{
					content: [{ type: "text", text: "Applied 1 replacement in 1 file." }],
					details: {
						xdev: {
							tool: "resolve",
							mode: "execute",
							args: { reason: "looks correct" },
							inner: {
								action: "apply",
								reason: "looks correct",
								sourceToolName: "ast_edit",
								label: "ast_edit: edit foo.ts",
							},
						},
					},
				}}
			/>,
		);

		expect(html).toContain(t("tools.toolResolve"));
		expect(html).toContain("proposed → resolved");
		expect(html).toContain("tv-badge--ok");
		expect(html).toContain("ast_edit: edit foo.ts");
		// The historical args-only path once left the badge as a warn "?".
		expect(html).not.toContain('tv-badge--warn">?');
	});

	it("renders xd://reject discard cards with reject semantics", () => {
		const html = renderToStaticMarkup(
			<ToolView
				name="write"
				defaultOpen
				result={{
					content: [{ type: "text", text: "Discarded pending action." }],
					details: {
						xdev: {
							tool: "reject",
							mode: "execute",
							args: { reason: "not right" },
							inner: { action: "discard", reason: "not right", sourceToolName: "edit" },
						},
					},
				}}
			/>,
		);

		expect(html).toContain(t("tools.toolReject"));
		expect(html).toContain("proposed → rejected");
		expect(html).toContain("tv-badge--warn");
		// Not the generic JSON dump.
		expect(html).not.toContain("tv-out-title");
	});

	it("defaults a running xd://reject to discard before details arrive", () => {
		const html = renderToStaticMarkup(<ToolView name="reject" defaultOpen running args={{ reason: "" }} />);

		expect(html).toContain("proposed → rejected");
	});

	it("renders xd://propose plan metadata from unwrapped inner details", () => {
		const html = renderToStaticMarkup(
			<ToolView
				name="write"
				defaultOpen
				result={{
					content: [{ type: "text", text: "Plan ready for review." }],
					details: {
						xdev: {
							tool: "propose",
							mode: "execute",
							args: { title: "ship it" },
							inner: { planFilePath: "local://ship-it-plan.md", title: "ship it", planExists: true },
						},
					},
				}}
			/>,
		);

		expect(html).toContain(t("tools.toolPropose"));
		expect(html).toContain("plan proposed");
		expect(html).toContain("local://ship-it-plan.md");
	});

	it("keeps historical top-level resolve cards working from args.action", () => {
		const html = renderToStaticMarkup(
			<ToolView
				name="resolve"
				defaultOpen
				args={{ action: "apply", reason: "ok" }}
				result={{ content: [], details: { sourceToolName: "ast_edit", label: "edit foo.ts" } }}
			/>,
		);

		expect(html).toContain("proposed → resolved");
		expect(html).toContain("tv-badge--ok");
	});

	it("routes the hub-family alias irc through the messaging renderer", () => {
		const html = renderToStaticMarkup(
			<ToolView name="irc" defaultOpen args={{ op: "send", to: "Main", message: "hi" }} result={{ content: [] }} />,
		);

		expect(html).toContain("→ Main");
		// Not the generic JSON dump of the args.
		expect(html).not.toContain("tv-out-title");
	});

	it("routes the hub-family alias job through the job renderer", () => {
		const html = renderToStaticMarkup(
			<ToolView name="job" defaultOpen args={{ poll: ["a1b2"] }} result={{ content: [] }} />,
		);

		expect(html).toContain("poll a1b2");
		expect(html).not.toContain("tv-out-title");
	});

	it("shows structured browser operations from live updates and persisted results", () => {
		const details = {
			action: "run",
			name: "main",
			operations: [
				{ id: "1", action: "observe", status: "completed", startedAt: 1, elementCount: 4 },
				{ id: "2", action: "click", status: "running", startedAt: 2, target: "#go" },
			],
		};
		const live = renderToStaticMarkup(
			<ToolCard
				toolCallId="b1"
				name="browser"
				args={{ action: "run", code: "await tab.click('#go')" }}
				running
				partialResult={{ content: [], details }}
			/>,
		);
		const historical = renderToStaticMarkup(
			<ToolView name="browser" defaultOpen args={{ action: "run" }} result={{ content: [], details }} />,
		);

		expect(live).toContain("#go");
		expect(live).toContain("4");
		expect(historical).toContain("#go");
		expect(historical).toContain("4");
	});

	it("uses an extension tool view's label and icon in the shared card chrome", () => {
		registerExternalToolRenderers({
			android_emulator: {
				label: "Android 模拟器",
				Icon: () => <svg data-testid="android-tool-icon" />,
				Summary: ({ args }) => <span>截图 · {String(args.device)}</span>,
			},
		});
		try {
			const html = renderToStaticMarkup(
				<ToolView name="android_emulator" args={{ action: "screenshot", device: "emulator-5554" }} />,
			);
			expect(html).toContain("Android 模拟器");
			expect(html).toContain('data-testid="android-tool-icon"');
			expect(html).toContain("截图 · emulator-5554");
			expect(html).not.toContain(">android_emulator</span>");
		} finally {
			registerExternalToolRenderers({});
		}
	});

	it("renders notify_user as a foldable progress row with a right-aligned time", () => {
		const timestamp = Date.UTC(2026, 10, 22, 14, 50, 8);
		const html = renderToStaticMarkup(
			<ToolCard
				toolCallId="n1"
				name="notify_user"
				timestamp={timestamp}
				args={{ title: "检查渲染", message: "已确认 **bold** 生效。\n\n- 圆点\n- 标题" }}
			/>,
		);

		expect(html).toContain('class="tr-progress-update"');
		expect(html).toContain("tr-progress-dot");
		expect(html).toContain("检查渲染");
		expect(html).toContain("tr-progress-time");
		expect(html).toContain('dateTime="2026-11-22T14:50:08.000Z"');
		// A completed update starts folded; the body stays mounted so opening it
		// shows the markdown without a remount.
		expect(html).toContain('aria-expanded="false"');
		expect(html).toContain("tr-progress-body-wrap--closed");
		// Markdown body: bold + bullets, not a pre-wrap text blob.
		expect(html).toContain("<strong>bold</strong>");
		expect(html).toContain("<li>圆点</li>");
		expect(html).not.toContain("tv-card");
	});

	it("starts a running progress update expanded", () => {
		const html = renderToStaticMarkup(
			<ToolCard
				toolCallId="n2"
				name="notify_user"
				running
				timestamp={Date.UTC(2026, 10, 22, 14, 50, 8)}
				args={{ title: "正在构建", message: "编译中…" }}
			/>,
		);

		expect(html).toContain('data-running="true"');
		expect(html).toContain('aria-expanded="true"');
		expect(html).not.toContain("tr-progress-body-wrap--closed");
	});

	it("shows the running state with a live elapsed readout", () => {
		const html = renderToStaticMarkup(
			<ToolView name="bash" running startedAt={Date.now() - 3_000} args={{ command: "bun check" }} />,
		);

		expect(html).toContain("tv-meta");
		expect(html).toContain(t("tools.running"));
	});

	it("marks a failed call in the head", () => {
		const html = renderToStaticMarkup(
			<ToolView
				name="bash"
				args={{ command: "false" }}
				result={{ content: [{ type: "text", text: "boom" }], isError: true }}
			/>,
		);

		expect(html).toContain("tv-meta--err");
		expect(html).toContain(t("tools.failed"));
	});

	it("marks an interrupted call in the head", () => {
		const html = renderToStaticMarkup(
			<ToolCard toolCallId="w2" name="write" args={{ path: "game.js" }} interrupted />,
		);

		expect(html).toContain("tv-meta--warn");
		expect(html).toContain(t("tools.callInterruptedShort"));
	});

	it("settles a call with no result and an idle agent as interrupted", () => {
		const html = renderToStaticMarkup(
			<ToolCard toolCallId="w1" name="write" args={{ path: "game.js" }} interrupted />,
		);

		expect(html).toContain("tv-status--interrupted");
		expect(html).toContain("tv-interrupted");
		expect(html).not.toContain("tv-status--pending");
	});

	it("keeps a dispatched call pending while the agent is still working", () => {
		const html = renderToStaticMarkup(<ToolCard toolCallId="w1" name="write" args={{ path: "game.js" }} />);

		expect(html).toContain("tv-status--pending");
		expect(html).not.toContain("tv-status--interrupted");
	});
});
