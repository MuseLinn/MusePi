/**
 * Minimal logger — inline replacement for @oh-my-pi/pi-utils logger.
 * MusePi doesn't need winston/daily-rotate-file; structured console output.
 */

export type LogLevel = "error" | "warn" | "info" | "debug";

function emit(level: LogLevel, message: string, context?: Record<string, unknown>): void {
	const ts = new Date().toISOString();
	const base = `[${ts}] [${level.toUpperCase()}] ${message}`;
	if (context && Object.keys(context).length > 0) {
		console[level === "error" ? "error" : level === "warn" ? "warn" : "log"](base, JSON.stringify(context));
	} else {
		console[level === "error" ? "error" : level === "warn" ? "warn" : "log"](base);
	}
}

export function error(message: string, context?: Record<string, unknown>): void {
	emit("error", message, context);
}

export function warn(message: string, context?: Record<string, unknown>): void {
	emit("warn", message, context);
}

export function info(message: string, context?: Record<string, unknown>): void {
	emit("info", message, context);
}

export function debug(message: string, context?: Record<string, unknown>): void {
	emit("debug", message, context);
}

/** Structured log event forwarded to out-of-band sinks. */
export interface LogEvent {
	readonly level: LogLevel;
	readonly message: string;
	readonly context: Record<string, unknown> | undefined;
	readonly timestamp: Date;
}

const logSinks = new Set<(event: LogEvent) => void>();

export function registerLogSink(sink: (event: LogEvent) => void): () => void {
	logSinks.add(sink);
	return () => {
		logSinks.delete(sink);
	};
}
