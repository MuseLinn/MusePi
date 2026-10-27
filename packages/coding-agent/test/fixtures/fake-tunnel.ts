import * as fs from "node:fs";

function requiredEnv(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`${name} is required`);
	return value;
}

const argsFile = requiredEnv("OMP_FAKE_TUNNEL_ARGS");
const signalsFile = requiredEnv("OMP_FAKE_TUNNEL_SIGNALS");
const args = process.argv.slice(2);
fs.writeFileSync(argsFile, args.length > 0 ? `${args.join("\n")}\n` : "");
fs.appendFileSync(requiredEnv("OMP_FAKE_TUNNEL_RUNS"), "run\n");

if (process.platform !== "win32") {
	for (const signal of ["SIGINT", "SIGTERM"] as const) {
		process.on(signal, () => {
			fs.appendFileSync(signalsFile, `${signal}\n`);
			process.exit(0);
		});
	}
}

const output = process.env.OMP_FAKE_TUNNEL_OUTPUT;
if (output) console.log(output);

const restartMarker = process.env.OMP_FAKE_TUNNEL_RESTART_MARKER;
if (restartMarker) {
	if (!fs.existsSync(restartMarker)) {
		fs.writeFileSync(restartMarker, "first\n");
		process.exit(23);
	}
	fs.appendFileSync(restartMarker, "restarted\n");
}

const exitCode = process.env.OMP_FAKE_TUNNEL_EXIT_CODE;
if (exitCode !== undefined) process.exit(Number(exitCode));
setInterval(() => {}, 60_000);
