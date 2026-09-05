import packageJson from "../../package.json" with { type: "json" };

export const VERSION = packageJson.version;
export const getLastChangelogVersionPath = (): string => "";
export const getChangelogPath = (): string | undefined => undefined;
export const isEnoent = (error: unknown): boolean =>
	typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
export const logger = { error: () => {}, warn: () => {} };
/** Config.ts is stubbed too; the probe exercises asset resolution, not paths. */
export const getMusepiChangelogPath = (): string | undefined => undefined;
/** Escape & < > for XML text bodies (minimal; the probe never renders XML). */
export const escapeXmlText = (input: string): string => input;
/** Extract an HTTP status from an error object (stub: probe never hits HTTP). */
export const extractHttpStatusFromError = (): undefined => undefined;
/** Whether an error is retryable (stub: probe never retries). */
export const isRetryableError = (): boolean => false;
/** Environment proxy (process.env read-through); the bundle probe never reads it. */
export const $env: Record<string, string | undefined> = new Proxy({} as Record<string, string | undefined>, {
	get: (_, key) => process.env[String(key)],
	has: (_, key) => key in process.env,
});
