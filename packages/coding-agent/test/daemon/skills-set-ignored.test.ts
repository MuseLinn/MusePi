/**
 * skills.setIgnored 契约测试：能力中心启停开关的写路径。
 *
 * 契约（GUI 抽屉开关 + 批量启停共用此 RPC）：
 * 1. 停用 = 向 skills.ignoredSkills 追加精确名，启用 = 恰好移除该名；
 *    用户手写的 glob 模式与其他条目原样保留（服务端 read-modify-write，
 *    不整键覆盖）。
 * 2. 批量 names 一次写完 —— 一次调用内多个名字同时生效，而不是逐次
 *    读改写留下互相覆盖的窗口。
 * 3. listSkills 的 ignored 标志与写入结果一致（glob 匹配在响应时计算）。
 */
import { describe, expect, test } from "bun:test";
import { Settings } from "@musepi/pi-coding-agent/config/settings";
import { MarketplaceService } from "../../src/daemon/services/marketplace-service";

function makeService(settings: Settings): MarketplaceService {
	return new MarketplaceService({
		cwd: () => "",
		settings: () => settings,
		extensionEntries: async () => [],
		invalidateExtensionsCache: () => {},
		invalidatePluginCaches: () => {},
		onChanged: () => {},
		onInstallState: () => {},
	});
}

describe("skills.setIgnored", () => {
	test("停用追加精确名、再启用恰好移除；既有 glob 模式原样保留", async () => {
		const settings = Settings.isolated();
		settings.set("skills.ignoredSkills", ["experimental-*"]);
		const service = makeService(settings);

		await service.setSkillsIgnored({ names: ["commit-helper"], ignored: true });
		expect(settings.get("skills.ignoredSkills")).toEqual(["experimental-*", "commit-helper"]);

		await service.setSkillsIgnored({ names: ["commit-helper"], ignored: false });
		expect(settings.get("skills.ignoredSkills")).toEqual(["experimental-*"]);
	});

	test("批量 names 一次写完，重复停用不堆重复条目", async () => {
		const settings = Settings.isolated();
		const service = makeService(settings);

		await service.setSkillsIgnored({ names: ["a", "b"], ignored: true });
		await service.setSkillsIgnored({ names: ["a"], ignored: true });
		expect(settings.get("skills.ignoredSkills")).toEqual(["a", "b"]);

		await service.setSkillsIgnored({ names: ["a", "b"], ignored: false });
		expect(settings.get("skills.ignoredSkills")).toEqual([]);
	});
});
