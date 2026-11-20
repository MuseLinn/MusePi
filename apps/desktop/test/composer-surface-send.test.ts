import { describe, expect, it, vi } from "bun:test";
import { createSurfaceSend } from "../src/components/composer/surface";

/**
 * One send contract, two handlers (ADR 0004). The entry picks the variant's
 * handler; the future single body calls this without knowing which skin is up.
 * The routing itself must not drift: a payload field that only one side
 * understands has to reach the handler that understands it.
 */
describe("createSurfaceSend", () => {
	it("hands the whole payload to the hero handler", () => {
		const onSubmit = vi.fn();
		const onSend = vi.fn();
		const send = createSurfaceSend({ variant: "hero", onSubmit, onSend });
		const payload = { planMode: true, files: [] as File[], images: [] };
		void send("hello", payload);
		expect(onSubmit).toHaveBeenCalledWith("hello", payload);
		expect(onSend).not.toHaveBeenCalled();
	});

	it("unpacks the session fields positionally", () => {
		const onSubmit = vi.fn();
		const onSend = vi.fn();
		const send = createSurfaceSend({ variant: "session", onSubmit, onSend });
		const images = [{ type: "image" as const, data: "data:,x", mimeType: "image/png" }];
		void send("hello", { images, deliverAs: "steer", displayContext: { quotes: [] }, videos: [] });
		expect(onSend).toHaveBeenCalledWith("hello", images, "steer", { quotes: [] }, []);
		expect(onSubmit).not.toHaveBeenCalled();
	});
});
