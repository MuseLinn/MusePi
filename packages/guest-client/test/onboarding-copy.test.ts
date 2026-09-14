import { describe, expect, test } from "bun:test";
import { enUS } from "../src/i18n/en-US/index.js";
import { t } from "../src/i18n/index.js";
import { zhCN } from "../src/i18n/zh-CN/index.js";

/**
 * Onboarding copy contract (P1 restructure — 8 steps → 3 main + 3 branches).
 *
 * The wizard's step titles/bodies and the done-step branch labels are looked
 * up by key from STEP_TITLES / STEP_BODIES in OnboardingOverlay.tsx. A key
 * with no dictionary entry silently falls back to the raw key (the key IS
 * the English string), which would ship "onboarding branch import" as
 * visible copy — this locks the three restructured surfaces instead:
 *   main step 1 (语言与外观) · main step 2 (连接模型) · done step + branches.
 */
const RESTRUCTURE_KEYS = [
	// Main spine: merged language/appearance step + done step.
	"onboarding title main1",
	"onboarding step main1",
	"onboarding title done",
	"onboarding step done",
	"onboarding branches label",
	// Done-step optional branches.
	"onboarding branch import",
	"onboarding branch personalize",
	"onboarding branch features",
	// Provider step reuses the original copy; the feature tour reuses the
	// three promo feature pages — all four must stay present.
	"onboarding title6",
	"onboarding step6",
	"onboarding title3",
	"onboarding title4",
	"onboarding title5",
] as const;

describe("onboarding copy (3 main steps + 3 branches)", () => {
	test("every restructured key has a zh-CN entry", () => {
		for (const key of RESTRUCTURE_KEYS) {
			expect(zhCN[key as keyof typeof zhCN], `zh-CN missing "${key}"`).toBeTruthy();
		}
	});

	test("every restructured key has an en-US entry distinct from the key", () => {
		for (const key of RESTRUCTURE_KEYS) {
			const value = enUS[key as keyof typeof enUS];
			expect(value, `en-US missing "${key}"`).toBeTruthy();
			// A missing entry would fall back to the key itself.
			expect(value, `en-US "${key}" falls back to the raw key`).not.toBe(key);
		}
	});

	test("t() resolves the merged-step and branch labels (no raw-key fallback)", async () => {
		const { setLocale, getLocaleSnapshot } = await import("../src/i18n/index.js");
		const initial = getLocaleSnapshot();
		try {
			setLocale("zh-CN");
			expect(t("onboarding title main1")).toBe("语言与外观");
			expect(t("onboarding title done")).toBe("一切就绪");
			expect(t("onboarding branch import")).toBe("导入会话");
			expect(t("onboarding branch personalize")).toBe("个性化");
			expect(t("onboarding branch features")).toBe("功能速览");
			setLocale("en-US");
			expect(t("onboarding title main1")).toBe("Language & appearance");
			expect(t("onboarding branch import")).toBe("Import sessions");
		} finally {
			setLocale(initial);
		}
	});
});
