/**
 * HF-compatible hub origins with mainland-China mirror fallback.
 *
 * 快赢包 A1:语音模型下载此前硬编码 `https://huggingface.co`,大陆网络下
 * Whisper/Kokoro/Sherpa 模型永远下不来,语音输入/TTS 首次使用即失败。
 * 这里提供三样东西:
 *
 * 1. {@link resolveHubOrigins} — 源清单(可用 `MUSEPI_HUB_ORIGINS` 覆盖,
 *    逗号分隔,企业内网镜像也能接);
 * 2. {@link preferredHubOrigin} — 并发 HEAD 探测选出首个可达源(带进程级
 *    memo,探测一次终身复用;全部失败时回退清单首项,让真正的下载错误
 *    以原始形态抛给调用方);
 * 3. {@link fetchHubFile} — 按偏好序逐源尝试的下载原语(`.part` 续传等
 *    细节留给调用方)。
 *
 * 设计借鉴 dsh `experimental/speech-to-text-sensevoice/src/model-sources.ts`
 * (0.1.7-rc.2),但零依赖、不引 cordis。
 */
import { $env } from "@musepi/pi-utils";

/** Default origin list: upstream first, mirror fallback. */
const DEFAULT_HUB_ORIGINS: readonly string[] = ["https://huggingface.co", "https://hf-mirror.com"];

/** HEAD probe deadline — long enough for a cold mirror, short enough to not stall first use. */
const PROBE_TIMEOUT_MS = 3_500;

/** `MUSEPI_HUB_ORIGINS` cache (process-lifetime env is stable). */
let cachedOrigins: readonly string[] | undefined;

/**
 * Resolve the ordered hub origin list. `MUSEPI_HUB_ORIGINS="a,b"` overrides
 * the default entirely (single-source setups keep a one-element list and skip
 * probing); unset/empty falls back to upstream + hf-mirror.
 */
export function resolveHubOrigins(): readonly string[] {
	cachedOrigins ??= ((): readonly string[] => {
		const override = $env.MUSEPI_HUB_ORIGINS?.trim();
		if (override) {
			const list = override
				.split(",")
				.map(origin => origin.trim())
				.filter(Boolean);
			if (list.length > 0) return list;
		}
		return DEFAULT_HUB_ORIGINS;
	})();
	return cachedOrigins;
}

let preferredOriginPromise: Promise<string> | undefined;

/**
 * Race HEAD probes against every configured origin; the first responder wins
 * and the rest keep their configured order as fallbacks for {@link fetchHubFile}.
 * Memoized per process — the outcome cannot change mid-session, and every
 * subsequent call must be free. When every probe fails (fully offline), the
 * configured first origin is returned so the real fetch surfaces its own,
 * more diagnostic error instead of a probe error.
 */
export function preferredHubOrigin(signal?: AbortSignal): Promise<string> {
	preferredOriginPromise ??= probeOrigins(resolveHubOrigins(), signal);
	return preferredOriginPromise;
}

async function probeOrigins(origins: readonly string[], signal?: AbortSignal): Promise<string> {
	if (origins.length === 1) return origins[0]!;
	const raced = origins.map(async origin => {
		const timeout = AbortSignal.timeout(PROBE_TIMEOUT_MS);
		const probeSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
		const response = await fetch(origin, { method: "HEAD", signal: probeSignal });
		if (!response.ok && response.status >= 500) throw new Error(`origin ${origin} HTTP ${response.status}`);
		return origin;
	});
	try {
		return await Promise.any(raced);
	} catch {
		return origins[0]!;
	}
}

/** Ordered origins with the probe winner hoisted first (probe result reused). */
export async function orderedHubOrigins(): Promise<readonly string[]> {
	const origins = resolveHubOrigins();
	if (origins.length === 1) return origins;
	const preferred = await preferredHubOrigin();
	return [preferred, ...origins.filter(origin => origin !== preferred)];
}

/**
 * Fetch one hub path (`<repo>/resolve/main/<file>` style), trying each origin
 * in preference order until one returns a response. Non-OK responses are
 * retried on the next origin (a mirror may lag a repo); transport failures
 * likewise. Re-throws the LAST error when every origin failed, so the message
 * names a real attempt rather than the probe.
 */
export async function fetchHubFile(pathname: string, init?: RequestInit): Promise<Response> {
	const errors: unknown[] = [];
	for (const origin of await orderedHubOrigins()) {
		try {
			const response = await fetch(`${origin}/${pathname}`, init);
			if (response.ok) return response;
			errors.push(new Error(`${origin}/${pathname}: HTTP ${response.status}`));
			// Body must be drained/cancelled before the connection can be reused.
			await response.body?.cancel().catch(() => {});
		} catch (error) {
			errors.push(error);
		}
	}
	throw errors.at(-1) instanceof Error ? errors.at(-1)! : new Error(`all hub origins failed for ${pathname}`);
}
