import { describe, expect, it } from "bun:test";
import { BUILTIN_TOOLS } from "../src/tools";
import { NotifyUserTool } from "../src/tools/notify-user";

function sessionWith(notifyUser: boolean): { settings: { get(key: string): unknown } } {
	return { settings: { get: (key: string) => (key === "notifyUser" ? notifyUser : undefined) } };
}

describe("notify_user tool", () => {
	it("is absent from a session until the setting is on", () => {
		expect(BUILTIN_TOOLS.notify_user(sessionWith(false) as never)).toBeNull();
		expect(BUILTIN_TOOLS.notify_user(sessionWith(true) as never)).toBeInstanceOf(NotifyUserTool);
	});

	it("returns the update as details and tells the model not to restate it", async () => {
		const tool = new NotifyUserTool(sessionWith(true) as never);
		const result = await tool.execute("call-1", {
			title: "Found the cause",
			message: "The rail measures a 1px range.\nNext: tighten the threshold.",
		});
		expect(result.details).toEqual({
			title: "Found the cause",
			message: "The rail measures a 1px range.\nNext: tighten the threshold.",
		});
		expect(result.content?.[0]).toMatchObject({ type: "text" });
		expect(tool.loadMode).toBe("essential");
	});
});
