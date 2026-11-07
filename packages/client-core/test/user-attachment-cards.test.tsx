import { describe, expect, test } from "bun:test";
import type { TextContent } from "@musepi/pi-wire";
import { renderToStaticMarkup } from "react-dom/server";
import { UserMsgContent } from "../src/components/transcript/transcript-content";
import { t } from "../src/i18n/index.js";
import type { ToolRenderHost } from "../src/tool-render/types";

const hash = "a".repeat(64);
const content = `[Attachment] blob://${hash} (notes.txt)\n请总结`;

/**
 * Guest/HTML-export hosts have no attachment capability: the cards must still
 * render from the message text, without size or a preview action, and the
 * reference line must not leak into the body.
 */

describe("UserMsgContent attachment cards", () => {
	test("renders a card and strips the reference line without a host", () => {
		const html = renderToStaticMarkup(<UserMsgContent content={content} plain collapse={false} />);

		expect(html).toContain("tr-attach-cards");
		expect(html).toContain("tr-attach-card");
		expect(html).toContain("notes.txt");
		expect(html).not.toContain("blob://");
		expect(html).toContain(t("tools.attachmentCopyRef"));
		expect(html).not.toContain(`>${t("tools.attachmentPreview")}<`);
	});

	test("shows the preview action only when the host can read blobs", () => {
		const host: ToolRenderHost = {
			attachment: {
				stat: async () => ({ exists: true, size: 2048 }),
				read: async () => ({ content: "", size: 0, offset: 0 }),
			},
		};

		const html = renderToStaticMarkup(<UserMsgContent content={content} plain collapse={false} host={host} />);

		expect(html).toContain(`>${t("tools.attachmentPreview")}<`);
	});

	test("keeps a name-only mention in the body", () => {
		const html = renderToStaticMarkup(
			<UserMsgContent content={"[Attachment:notes.md]\n指令"} plain collapse={false} />,
		);

		expect(html).toContain("[Attachment:notes.md]");
		expect(html).not.toContain("tr-attach-card");
	});

	test("renders cards for structured text blocks too", () => {
		const blocks: TextContent[] = [{ type: "text", text: content }];
		const html = renderToStaticMarkup(<UserMsgContent content={blocks} plain collapse={false} />);

		expect(html).toContain("tr-attach-card");
		expect(html).not.toContain("blob://");
	});
});
