const errText = (err: unknown): string => (err instanceof Error ? (err.stack ?? String(err)) : String(err));

process.on("uncaughtException", err => {
	console.error("UNCAUGHT:", errText(err));
	process.exit(1);
});
process.on("unhandledRejection", err => {
	console.error("UNHANDLED:", errText(err));
	process.exit(1);
});

async function main() {
	const { runCli } = await import("./cli.ts");
	const steps: Array<[string, () => void | Promise<void>]> = [
		[
			"delete env",
			() => {
				try {
					delete process.env.MallocStackLogging;
					delete process.env.MallocStackLoggingNoCompact;
				} catch {}
			},
		],
		[
			"MIN_BUN_VERSION",
			async () => {
				const { MIN_BUN_VERSION } = await import("@musepi/pi-utils/dirs");
				return MIN_BUN_VERSION;
			},
		],
		[
			"setProcessName",
			async () => {
				const { setProcessName } = await import("@musepi/pi-utils/process-name");
				setProcessName("musepi");
			},
		],
		[
			"profile-alias",
			async () => {
				await import("./cli/profile-alias");
			},
		],
		[
			"profile-bootstrap",
			async () => {
				await import("./cli/profile-bootstrap");
			},
		],
		[
			"eval process-entry",
			async () => {
				await import("./eval/js/process-entry");
			},
		],
		[
			"worker-protocol",
			async () => {
				await import("./eval/js/worker-protocol");
			},
		],
		[
			"launch protocol",
			async () => {
				await import("./launch/protocol");
			},
		],
		[
			"terminal-output-worker-protocol",
			async () => {
				await import("./launch/terminal-output-worker-protocol");
			},
		],
		[
			"computer protocol",
			async () => {
				await import("./tools/computer/protocol");
			},
		],
		[
			"computer supervisor",
			async () => {
				await import("./tools/computer/supervisor");
			},
		],
		[
			"computer worker-entry",
			async () => {
				await import("./tools/computer/worker-entry");
			},
		],
		[
			"runCli",
			async () => {
				await runCli(process.argv.slice(2));
			},
		],
	];
	for (const [name, fn] of steps) {
		const t0 = Date.now();
		try {
			const maybePromise = fn();
			if (maybePromise && typeof maybePromise.then === "function") await maybePromise;
		} catch (e) {
			console.error(`STEP FAILED ${name} (+${Date.now() - t0}ms):`, errText(e));
			process.exit(1);
		}
		console.error(`STEP OK ${name} (+${Date.now() - t0}ms)`);
	}
}
main().catch(err => {
	console.error("TOP FAILED:", errText(err));
	process.exit(1);
});
