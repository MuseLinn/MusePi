const output = process.env.FAKE_NGROK_OUTPUT ?? "";
const exitCode = process.env.FAKE_NGROK_EXIT_CODE;
const delayMs = Number(process.env.FAKE_NGROK_DELAY_MS ?? "30");

setTimeout(() => {
	if (output) console.log(output);
	if (exitCode) process.exit(Number(exitCode));
	if (process.platform !== "win32") process.on("SIGTERM", () => process.exit(0));
	setInterval(() => {}, 1000);
}, delayMs);
