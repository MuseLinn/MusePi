const errText = (err: unknown): string => (err instanceof Error ? (err.stack ?? String(err)) : String(err));

process.on("uncaughtException", err => {
	console.error("UNCAUGHT:", errText(err));
	process.exit(1);
});
process.on("unhandledRejection", err => {
	console.error("UNHANDLED:", errText(err));
	process.exit(1);
});

const { runCli } = await import("./cli.ts");

const steps = [
	'import("@musepi/pi-utils/cli")',
	'import("./cli-commands")',
	"run()",
	"Index.run()",
	"prepareAcpTerminalAuthArgs",
	"parseArgs",
	"runRootCommand",
	"initTheme",
	"applyStartupCwd",
	"discoverAuthStorage",
	"settings.init",
	"initializeWithSettings",
	"InteractiveMode",
];

async function traceStep(name: string) {
	console.error(`>>> ${name}`);
}

for (const s of steps) await traceStep(s);

await runCli(process.argv.slice(2));
