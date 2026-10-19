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
 * the English string), which would ship "settings.onboardingBranchImport" as
 * visible copy — this locks the three restructured surfaces instead:
 *   main step 1 (语言与外观) · main step 2 (连接模型) · done step + branches.
 */
const RESTRUCTURE_KEYS = [
	// Main spine: merged language/appearance step + done step.
	"settings.onboardingTitleMain1",
	"settings.onboardingStepMain1",
	"settings.onboardingTitleDone",
	"settings.onboardingStepDone",
	"settings.onboardingBranchesLabel",
	// Done-step optional branches.
	"settings.onboardingBranchImport",
	"settings.onboardingBranchPersonalize",
	"settings.onboardingBranchFeatures",
	// Design mode branch (2026-09-18): new capability, must exist in both locales.
	"settings.onboardingBranchDesign",
	"settings.onboardingBranchDesignBody",
	"settings.onboardingBranchDesignEntries",
	// Provider step reuses the original copy; the feature tour reuses the
	// three promo feature pages — all four must stay present.
	"settings.onboardingTitle6",
	"settings.onboardingStep6",
	"settings.onboardingTitle3",
	"settings.onboardingTitle4",
	"settings.onboardingTitle5",
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
			expect(t("settings.onboardingTitleMain1")).toBe("语言与外观");
			expect(t("settings.onboardingTitleDone")).toBe("一切就绪");
			expect(t("settings.onboardingBranchImport")).toBe("导入会话");
			expect(t("settings.onboardingBranchPersonalize")).toBe("个性化");
			expect(t("settings.onboardingBranchFeatures")).toBe("功能速览");
			setLocale("en-US");
			expect(t("settings.onboardingTitleMain1")).toBe("Language & appearance");
			expect(t("settings.onboardingBranchImport")).toBe("Import sessions");
		} finally {
			setLocale(initial);
		}
	});
});
