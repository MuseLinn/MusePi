/**
 * Daemon commands whose route name is easy to lose.
 *
 * These five calls were the ones a bulk string rewrite silently renamed
 * (`session.setModel` became `settings.sessionSetmodel`, `providers.loginInput`
 * became `settings.providersLogininput`): a wire method is an opaque string, so
 * the compiler sees nothing and the miss only shows up at runtime — where most
 * call sites swallowed the rejection. Each route now has one spelling shared by
 * every surface that sends it, and `scripts/rpc-commands.test.ts` pins each
 * spelling to the dispatcher (`scripts/check-rpc-method-names.test.ts` covers
 * the gate that keeps those spellings honest).
 */
import type { CustomProviderPayload } from "../components/CustomProviderForm";

/** The single call these helpers make; a test can stand in for the client. */
export interface RpcInvoker {
	request<T = unknown>(method: string, params?: unknown): Promise<T>;
}

/** Switch one live session's model (TUI `/switch` parity — other sessions keep theirs). */
export function setSessionModel(
	rpc: RpcInvoker,
	params: { sessionId: string; model: { id: string; name?: string; provider?: string } },
): Promise<unknown> {
	return rpc.request("session.setModel", params);
}

/** Answer a pending provider prompt (device code, API-key paste, …). */
export function submitProviderLoginInput(rpc: RpcInvoker, providerId: string, value: string): Promise<unknown> {
	return rpc.request("providers.loginInput", { providerId, value });
}

/** Abort the in-flight provider login for a provider. */
export function cancelProviderLogin(rpc: RpcInvoker, providerId: string): Promise<unknown> {
	return rpc.request("providers.loginCancel", { providerId });
}

/** Remove every stored credential, or only `credentialId` when given. */
export function logoutProvider(
	rpc: RpcInvoker,
	params: { providerId: string; credentialId?: number },
): Promise<unknown> {
	return rpc.request("providers.logout", params);
}

/** Register a custom OpenAI-compatible provider in the model registry. */
export function addProviderModels(
	rpc: RpcInvoker,
	provider: CustomProviderPayload,
	sessionId?: string | null,
): Promise<unknown> {
	return rpc.request("models.add", { sessionId: sessionId ?? undefined, provider });
}
