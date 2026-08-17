import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import type { ImageContent } from "@musepi/pi-ai";
import { AssistantMessageComponent } from "@musepi/pi-coding-agent/modes/components/assistant-message";
import { ToolExecutionComponent } from "@musepi/pi-coding-agent/modes/components/tool-execution";
import { initTheme } from "@musepi/pi-coding-agent/modes/theme/theme";
import { ImageProtocol, setTerminalImageProtocol, TERMINAL } from "@musepi/pi-tui";

const IMAGE: ImageContent = {
	type: "image",
	data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
	mimeType: "image/jpeg",
};
const originalProtocol = TERMINAL.imageProtocol;

describe("Kitty non-PNG conversion failures", () => {
	beforeAll(async () => {
		await initTheme();
	});

	beforeEach(() => {
		setTerminalImageProtocol(ImageProtocol.Kitty);
		vi.spyOn(Bun.Image.prototype, "png").mockImplementation(() => {
			throw new TypeError("synchronous image conversion failure");
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
		setTerminalImageProtocol(originalProtocol);
	});

	it("omits restored tool-result images when conversion throws synchronously", () => {
		let imageUpdates = 0;
		const component = new AssistantMessageComponent(undefined, false, () => imageUpdates++);

		component.setToolResultImages("restored-read", [IMAGE]);
		expect(imageUpdates).toBe(0);
	});

	it("omits live tool-result images when conversion throws synchronously", () => {
		const requestRender = vi.fn();
		const component = new ToolExecutionComponent("read", { path: "repro.jpg" }, {}, undefined, {
			requestRender,
			requestComponentRender: vi.fn(),
			resetDisplay: vi.fn(),
		});

		component.updateResult({ content: [IMAGE] }, false);
		expect(requestRender).not.toHaveBeenCalled();
	});
});
