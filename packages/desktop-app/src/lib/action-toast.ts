/**
 * Desktop entry for the shared in-app toast store.
 *
 * The store itself lives in `@musepi/client-core` so the desktop shell and the
 * guest/mobile shell share one list. This module stays as the stable relative
 * path (`lib/action-toast`) that `EXTENSION_HOST_MODULES` resolves for compiled
 * plugins; re-exporting (rather than duplicating) keeps one identity.
 */
export {
	type ActionToast,
	type ActionToastInput,
	type ActionToastKind,
	dismissActionToast,
	dismissActionToastSource,
	getToasts,
	MAX_ACTION_TOASTS,
	pauseActionToast,
	pushActionToast,
	resumeActionToast,
	setActionToastTtl,
	subscribeActionToasts,
	ttlFor,
} from "@musepi/client-core/src/lib/action-toast";
