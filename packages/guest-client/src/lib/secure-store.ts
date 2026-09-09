/**
 * Secure storage for collab credentials (room links carry the E2E key).
 *
 * Desktop web: plain localStorage (no Keystore available).
 * Capacitor shell: writes go to the OS secure store (Android Keystore /
 * iOS Keychain) via @aparajita/capacitor-secure-storage, with localStorage
 * kept as a synchronous mirror for first-render reads and migration. The
 * plugin's high-level get/set is known to stall in some WebViews (openchamber
 * hit the same wall), so we use the internal item API behind a timeout and
 * fall back to the localStorage mirror on any failure — the app never blocks
 * or loses a credential over storage trouble.
 */

const PREFIX = "musepi.mobile.";
const TIMEOUT_MS = 2000;
const KEYCHAIN_ACCESS_WHEN_UNLOCKED = 0;

type NativeSecureStorage = {
	internalSetItem: (options: { prefixedKey: string; data: string; sync: boolean; access: number }) => Promise<void>;
	internalGetItem: (options: { prefixedKey: string; sync: boolean }) => Promise<{ data: string | null }>;
	internalRemoveItem: (options: { prefixedKey: string; sync: boolean }) => Promise<{ success: boolean }>;
};

function isNativeShell(): boolean {
	return typeof window !== "undefined" && (window as unknown as { Capacitor?: unknown }).Capacitor != null;
}

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

async function nativeStore(): Promise<NativeSecureStorage | null> {
	if (!isNativeShell()) return null;
	try {
		const { SecureStorage } = await import("@aparajita/capacitor-secure-storage");
		const native = SecureStorage as unknown as NativeSecureStorage;
		// The plugin export is a Capacitor plugin proxy: its get trap routes
		// EVERY property access — including `then` — through the bridge, so
		// awaiting the returned object (or Promise.resolve()-ing it) throws
		// "SecureStorage.then() is not implemented on android". Bind the three
		// methods into a plain object so callers never await the proxy itself.
		return {
			internalGetItem: o => native.internalGetItem(o),
			internalSetItem: o => native.internalSetItem(o),
			internalRemoveItem: o => native.internalRemoveItem(o),
		};
	} catch {
		return null;
	}
}

/** Read a credential: secure store first, then the localStorage mirror. */
export async function secureGet(key: string): Promise<string | null> {
	const mirror = localStorage.getItem(key);
	const store = await nativeStore();
	if (!store) return mirror;
	const { data } = await withTimeout(store.internalGetItem({ prefixedKey: PREFIX + key, sync: false }), {
		data: null,
	});
	return data ?? mirror;
}

/** Write a credential: localStorage mirror first (sync read path + migration),
 *  then the OS secure store. Never throws. */
export async function secureSet(key: string, value: string): Promise<void> {
	localStorage.setItem(key, value);
	const store = await nativeStore();
	if (!store) return;
	await withTimeout(
		store.internalSetItem({
			prefixedKey: PREFIX + key,
			data: value,
			sync: true,
			access: KEYCHAIN_ACCESS_WHEN_UNLOCKED,
		}),
		undefined,
	);
}

/** Forget a credential (both layers). */
export async function secureRemove(key: string): Promise<void> {
	localStorage.removeItem(key);
	const store = await nativeStore();
	if (!store) return;
	await withTimeout(store.internalRemoveItem({ prefixedKey: PREFIX + key, sync: false }), { success: false });
}
