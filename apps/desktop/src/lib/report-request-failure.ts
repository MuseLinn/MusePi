/**
 * Surface a rejected daemon call as a visible toast with the daemon's reason.
 *
 * A wire method is an opaque string, so a wrong or removed route compiles
 * clean and rejects only at runtime; a bare `.catch(() => {})` after the call
 * then makes the user's click look ignored. Every RPC failure a user
 * triggered reports through here: `title` names the operation that failed,
 * the daemon's message says why.
 */
import { t } from "@musepi/client-core";
import { pushActionToast } from "./action-toast";

export function reportRequestFailure(title: string, err: unknown): void {
	pushActionToast({
		kind: "error",
		title,
		message: t("general.requestFailed"),
		details: err instanceof Error ? err.message : String(err),
	});
}
