// Test-global locale isolation: the dev machine's system locale may be
// zh-CN, and t() falls back to system locale — which would render Chinese
// in tests that assert English UI text. Pin en-US for the whole test run;
// tests that explicitly exercise locale switching call setLocale() and
// override this.
import { setLocale } from "../src/i18n/index.ts";

setLocale("en-US");
