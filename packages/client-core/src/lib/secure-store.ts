import { SecureStorage } from "@aparajita/capacitor-secure-storage";
import { isNativeShell } from "./capacitor";

/**
 * Secure storage for collab credentials (room links carry the E2E key).
 *
 * Desktop web: plain localStorage (no Keystore available).
 * Capacitor shell: writes go to the OS secure store (Android Keystore /
 * iOS Keychain) via @aparajita/capacitor-secure-storage. Legacy values keep a
 * localStorage mirror for synchronous reads. New host credentials opt out of
 * that mirror: a failed native write is reported instead of silently leaving
 * the E2E key in plaintext. The plugin's high-level get/set is known to stall
 * in some WebViews, so all native calls use the internal item API + timeout.
 */

const PREFIX = "musepi.mobile.";
const TIMEOUT_MS = 2000;
const KEYCHAIN_ACCESS_WHEN_UNLOCKED = 0;

type NativeSecureStorage = {
	internalSetItem: (options: { prefixedKey: string; data: string; sync: boolean; access: number }) => Promise<void>;
	internalGetItem: (options: { prefixedKey: string; sync: boolean }) => Promise<{ data: string | null }>;
	internalRemoveItem: (options: { prefixedKey: string; sync: boolean }) => Promise<{ success: boolean }>;
};

async function withTimeout<T>(operation: Promise<T>, fallback: T): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<T>(resolve => {
		timer = setTimeout(() => resolve(fallback), TIMEOUT_MS);
	});
	try {
		return await Promise.race([operation.catch(() => fallback), timeout]);
	} finally {
		clearTimeout(timer);
	}
}

function nativeStore(): NativeSecureStorage | null {
	if (!isNativeShell()) return null;
	const native = SecureStorage as unknown as NativeSecureStorage;
	// The plugin export is a Capacitor plugin proxy: its get trap routes
	// EVERY property access — including `then` — through the bridge, so
	// awaiting the returned object (or Promise.resolve()-ing it) throws
	// "SecureStorage.then() is not implemented on android". Bind the three
	// methods into a plain object so callers never await the proxy itself.
	// Static registration also avoids waiting for the shell's plugin startup
	// from a module that plugin startup itself initializes.
	return {
		internalGetItem: o => native.internalGetItem(o),
		internalSetItem: o => native.internalSetItem(o),
		internalRemoveItem: o => native.internalRemoveItem(o),
	};
}

/** Read a credential: secure store first, then the localStorage mirror. */
export async function secureGet(key: string): Promise<string | null> {
	const mirror = localStorage.getItem(key);
	const store = nativeStore();
	if (!store) return mirror;
	const { data } = await withTimeout(store.internalGetItem({ prefixedKey: PREFIX + key, sync: false }), {
		data: null,
	});
	return data ?? mirror;
}

/** Write a credential. Legacy callers keep their plaintext mirror; native
 *  callers with `{mirror:false}` fail closed when the OS store is unavailable. */
export async function secureSet(key: string, value: string, options: { mirror?: boolean } = {}): Promise<boolean> {
	const mirror = options.mirror ?? true;
	const native = isNativeShell();
	if (!native || mirror) localStorage.setItem(key, value);
	const store = nativeStore();
	if (!store) return !native || mirror;
	const stored = await withTimeout(
		store
			.internalSetItem({
				prefixedKey: PREFIX + key,
				data: value,
				sync: true,
				access: KEYCHAIN_ACCESS_WHEN_UNLOCKED,
			})
			.then(() => true),
		false,
	);
	if (stored && native && !mirror) localStorage.removeItem(key);
	return stored || mirror;
}

/** Forget a credential (both layers). */
export async function secureRemove(key: string): Promise<void> {
	localStorage.removeItem(key);
	const store = nativeStore();
	if (!store) return;
	await withTimeout(store.internalRemoveItem({ prefixedKey: PREFIX + key, sync: false }), { success: false });
}
