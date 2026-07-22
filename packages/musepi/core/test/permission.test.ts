// MusePi core — permission 无 UI 阻断措辞测试。
// 无 UI（print/RPC）时 block reason 必须明确告知模型"未执行"，防弱模型谎报成功。
import assert from "node:assert";
import { describe, it } from "node:test";
import { permissionManager } from "../src/permission/index.ts";

describe("permission no-UI block wording", () => {
	it("blocks with explicit NOT-executed, actionable reason", async () => {
		permissionManager.setMode("manual");
		const r = await permissionManager.evaluate("edit", { path: "src/app.ts" }, process.cwd(), {
			hasUI: false,
			sessionId: "perm-no-ui-test",
			ui: { confirm: async () => false },
		});
		assert.equal(r?.block, true);
		assert.match(r?.reason ?? "", /NOT executed/i);
		assert.match(r?.reason ?? "", /permission mode|interactively/i);
		assert.match(r?.reason ?? "", /edit/);
	});
});
