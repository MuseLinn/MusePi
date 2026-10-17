// Test-global locale isolation: the dev machine's system locale may be
// zh-CN, and t() falls back to system locale — which would render Chinese
// in tests that assert English UI text. Pin en-US for the whole test run;
// tests that explicitly exercise locale switching call setLocale() and
// override this.
// Daemon isolation must evaluate before anything imports session-host
// (its SOCKET_DIR/JOURNAL_DIR constants freeze at import time).
import "./preload-daemon-isolation";
import { setLocale } from "../src/i18n/index.ts";

setLocale("en-US");
