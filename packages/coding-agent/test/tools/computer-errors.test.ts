import { describe, expect, it } from "bun:test";
import { DesktopToolError, desktopErrorFrom, parseDesktopError } from "../../src/tools/computer/errors";
import { ToolError } from "../../src/tools/tool-errors";

describe("desktop error boundary", () => {
	it("splits a known native code from its detail", () => {
		expect(parseDesktopError("InvalidCoordinateFrame: no capture of '42' yet")).toEqual({
			code: "InvalidCoordinateFrame",
			detail: "no capture of '42' yet",
		});
	});

	it("keeps unknown and unprefixed messages whole", () => {
		expect(parseDesktopError("something else happened")).toEqual({
			code: "Internal",
			detail: "something else happened",
		});
		expect(parseDesktopError("NotACode: detail")).toEqual({
			code: "Internal",
			detail: "NotACode: detail",
		});
	});

	it("wraps an error into a ToolError that still carries the code", () => {
		const wrapped = desktopErrorFrom(new Error("BackgroundUnavailable: dropped"));
		expect(wrapped).toBeInstanceOf(ToolError);
		expect(wrapped).toBeInstanceOf(DesktopToolError);
		expect(wrapped.code).toBe("BackgroundUnavailable");
		expect(wrapped.detail).toBe("dropped");
		expect(wrapped.message).toBe("BackgroundUnavailable: dropped");
	});

	it("wraps non-error values without throwing", () => {
		expect(desktopErrorFrom("plain failure").code).toBe("Internal");
	});
});
