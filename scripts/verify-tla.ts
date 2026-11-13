import * as path from "node:path";

interface TlaCaseBase {
	name: string;
	module: string;
	config: string;
}

type TlaCase = TlaCaseBase & ({ expect: "pass" } | { expect: "counterexample"; invariant: string });

const root = path.resolve(import.meta.dir, "..");
const jar = process.env.TLA2TOOLS_JAR ?? path.join(root, ".kimi-tmp", "tla", "tla2tools.jar");
const cases: TlaCase[] = [
	{ name: "Lease safe", module: "Lease.tla", config: "Lease_Safe.cfg", expect: "pass" },
	{
		name: "Lease stale heartbeat",
		module: "Lease.tla",
		config: "Lease_StaleHeartbeat.cfg",
		expect: "counterexample",
		invariant: "NoStaleHeartbeat",
	},
	{ name: "Journal safe", module: "JournalAppend.tla", config: "JournalAppend_Safe.cfg", expect: "pass" },
	{
		name: "Journal dropped middle seq",
		module: "JournalAppend.tla",
		config: "JournalAppend_DropMiddle.cfg",
		expect: "counterexample",
		invariant: "NoSilentCatchup",
	},
	{
		name: "Journal renumber",
		module: "JournalAppend.tla",
		config: "JournalAppend_Renumber.cfg",
		expect: "counterexample",
		invariant: "NoRenumber",
	},
	{ name: "Intent safe", module: "IntentBeforeEffect.tla", config: "IntentBeforeEffect_Safe.cfg", expect: "pass" },
	{
		name: "Intent synchronous effect",
		module: "IntentBeforeEffect.tla",
		config: "IntentBeforeEffect_SyncEffect.cfg",
		expect: "counterexample",
		invariant: "EffectAfterDurable",
	},
	{ name: "Host safe", module: "HostPluginLifecycle.tla", config: "HostPluginLifecycle_Safe.cfg", expect: "pass" },
	{
		name: "Host unsafe lifecycle",
		module: "HostPluginLifecycle.tla",
		config: "HostPluginLifecycle_Unsafe.cfg",
		expect: "counterexample",
		invariant: "NoRollbackLoss",
	},
];

export function tlaCaseFailure(testCase: TlaCase, output: string, code: number): string | null {
	if (testCase.expect === "pass") return code === 0 ? null : output;
	const expected = `Invariant ${testCase.invariant} is violated`;
	return code !== 0 && output.includes(expected) ? null : `Expected ${expected}.\n${output}`;
}

async function verifyTla(): Promise<void> {
	if (!(await Bun.file(jar).exists())) {
		throw new Error(
			`TLA2 tools not found at ${jar}. Set TLA2TOOLS_JAR to a tla2tools.jar downloaded from the official TLA+ release.`,
		);
	}

	let failures = 0;
	for (const [index, testCase] of cases.entries()) {
		const config = path.join(root, "spec", testCase.config);
		const module = path.join(root, "spec", testCase.module);
		const metadir = path.join(root, ".kimi-tmp", `tla-state-${index}`);
		const nativePath = (value: string) => (process.platform === "win32" ? value.replaceAll("/", "\\") : value);
		const proc = Bun.spawn({
			cmd: [
				"java",
				"-jar",
				nativePath(jar),
				"-nowarning",
				"-metadir",
				nativePath(metadir),
				"-config",
				nativePath(config),
				nativePath(module),
			],
			cwd: root,
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, code] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		const output = `${stdout}${stderr}`.trim();
		const failure = tlaCaseFailure(testCase, output, code);
		if (failure !== null) {
			failures += 1;
			console.error(`[FAIL] ${testCase.name}: ${failure}`);
		} else if (testCase.expect === "counterexample") {
			console.log(`[expected counterexample] ${testCase.name}: Invariant ${testCase.invariant} is violated.`);
		} else {
			console.log(`[pass] ${testCase.name}`);
		}
	}

	if (failures > 0) throw new Error(`${failures} TLA+ case(s) did not match their expected result`);
	console.log(`${cases.length} TLA+ cases matched their expected result`);
}

if (import.meta.main) await verifyTla();
