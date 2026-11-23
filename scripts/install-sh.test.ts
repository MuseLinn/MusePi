import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const repoRoot = path.join(import.meta.dir, "..");
const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

async function run(
	command: string[],
	env: NodeJS.ProcessEnv,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const proc = Bun.spawn(command, {
		cwd: repoRoot,
		env,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	return { exitCode, stdout, stderr };
}

async function writeExecutable(directory: string, name: string, content: string): Promise<void> {
	const file = path.join(directory, name);
	await Bun.write(file, content);
	await fs.chmod(file, 0o755);
}

const releaseList = `[
  {
    "tag_name": "v0.7.8-beta.1",
    "prerelease": true,
    "assets": [
      { "name": "musepi-linux-x64" },
      { "name": "SHA256SUMS.txt" }
    ]
  },
  {
    "tag_name": "v0.7.7",
    "prerelease": false,
    "author": { "login": "MuseLinn", "name": "Muse Linn" },
    "assets": [
      { "name": "MusePi-0.7.7-x86_64.AppImage" },
      { "name": "MusePi-0.7.7-amd64.deb" }
    ]
  },
  {
    "tag_name": "v0.7.5",
    "prerelease": false,
    "assets": [
      { "name": "musepi-linux-x64" },
      { "name": "SHA256SUMS.txt" },
      { "name": "MusePi-0.7.5-amd64.deb" }
    ]
  }
]
`;

const latestMissing = `{
  "tag_name": "v0.7.7",
  "prerelease": false,
  "assets": [
    { "name": "MusePi-0.7.7-x86_64.AppImage" },
    { "name": "MusePi-0.7.7-amd64.deb" }
  ]
}
`;

const latestHasBinary = `{
  "tag_name": "v0.7.7",
  "prerelease": false,
  "assets": [
    { "name": "musepi-linux-x64" },
    { "name": "MusePi-0.7.7-amd64.deb" }
  ]
}
`;

async function fakeBin(mode: {
	asset?: "fail" | "ok";
	sums?: "fail" | "ok" | "empty";
	api?: "ok" | "down";
	latest?: string;
}): Promise<{ binDir: string; home: string }> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "musepi-install-sh-"));
	tempDirs.push(dir);
	const binDir = path.join(dir, "bin");
	await fs.mkdir(binDir);
	await writeExecutable(binDir, "uname", '#!/bin/sh\n[ "$1" = "-s" ] && echo Linux || echo x86_64\n');
	await writeExecutable(binDir, "ldd", "#!/bin/sh\necho 'ldd (Ubuntu GLIBC 2.35) 2.35'\n");
	await writeExecutable(
		binDir,
		"curl",
		`#!/bin/sh
outfile=""
url=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) outfile="$2"; shift 2 ;;
    -H|--max-time|--retry) shift 2 ;;
    -*) shift ;;
    *) url="$1"; shift ;;
  esac
done
fail() {
  echo "curl: (22) The requested URL returned error: 404" >&2
  exit 22
}
case "$url" in
  *api.github.com*)
    [ "$MUSEPI_API" = "down" ] && fail
    case "$url" in
      */releases/tags/*) printf '%s\\n' "$MUSEPI_LATEST_JSON" ;;
      */releases/latest*) printf '%s\\n' "$MUSEPI_LATEST_JSON" ;;
      *per_page=*) printf '%s\\n' "$MUSEPI_LIST_JSON" ;;
      *) echo "unexpected api url: $url" >&2; exit 99 ;;
    esac
    ;;
  *SHA256SUMS.txt*)
    [ "$MUSEPI_SUMS" = "fail" ] && fail
    [ -n "$outfile" ] || exit 0
    if [ "$MUSEPI_SUMS" = "empty" ]; then
      printf 'abcdef  musepi-linux-arm64\\n' > "$outfile"
    else
      printf 'abc  musepi-linux-x64\\n' > "$outfile"
    fi
    ;;
  *musepi-linux-x64*)
    [ "$MUSEPI_ASSET" = "fail" ] && fail
    [ -n "$outfile" ] && printf '#!/bin/sh\\necho 1.0.0\\n' > "$outfile"
    ;;
  *)
    echo "unexpected curl url: $url" >&2
    exit 99
    ;;
esac
`,
	);
	return { binDir, home: dir };
}

function envFor(
	bin: { binDir: string; home: string },
	extra: Record<string, string>,
): NodeJS.ProcessEnv {
	return {
		...process.env,
		PATH: `${bin.binDir}:${process.env.PATH ?? ""}`,
		HOME: bin.home,
		PI_BIN_DIR: path.join(bin.home, "install"),
		MUSEPI_LIST_JSON: releaseList,
		...extra,
	};
}

describe("install.sh missing TUI assets", () => {
	test("names the latest release and a release that still has the terminal binary", async () => {
		const bin = await fakeBin({});
		const result = await run(
			["sh", "scripts/install.sh", "--binary"],
			envFor(bin, {
				MUSEPI_ASSET: "fail",
				MUSEPI_API: "ok",
				MUSEPI_LATEST_JSON: latestMissing,
			}),
		);

		expect(result.exitCode, result.stderr).toBe(1);
		expect(result.stderr).toContain("GitHub release v0.7.7 does not include musepi-linux-x64");
		expect(result.stderr).toContain("sh install.sh --ref v0.7.5");
		expect(result.stderr).not.toContain("--ref v0.7.8-beta.1");
		expect(result.stderr).toContain("sh install.sh --source");
		expect(result.stdout).not.toContain("Installed musepi");
	});

	test("uses the requested tag when --ref names a release without the terminal binary", async () => {
		const bin = await fakeBin({});
		const result = await run(
			["sh", "scripts/install.sh", "--ref", "v0.7.7"],
			envFor(bin, {
				MUSEPI_ASSET: "fail",
				MUSEPI_API: "ok",
				MUSEPI_LATEST_JSON: latestMissing,
			}),
		);

		expect(result.exitCode, result.stderr).toBe(1);
		expect(result.stderr).toContain("GitHub release v0.7.7 does not include musepi-linux-x64");
		expect(result.stderr).toContain("--ref v0.7.5");
	});

	test("says the checksum file is missing and still points at a complete release", async () => {
		const bin = await fakeBin({});
		const result = await run(
			["sh", "scripts/install.sh", "--binary"],
			envFor(bin, {
				MUSEPI_ASSET: "ok",
				MUSEPI_SUMS: "fail",
				MUSEPI_API: "ok",
				MUSEPI_LATEST_JSON: latestHasBinary,
			}),
		);

		expect(result.exitCode, result.stderr).toBe(1);
		expect(result.stderr).toContain("GitHub release v0.7.7 does not include SHA256SUMS.txt");
		expect(result.stderr).toContain("--ref v0.7.5");
		expect(result.stdout).not.toContain("Installed musepi");
	});

	test("does not call a published file missing when the download itself failed", async () => {
		const bin = await fakeBin({});
		const result = await run(
			["sh", "scripts/install.sh", "--binary"],
			envFor(bin, {
				MUSEPI_ASSET: "fail",
				MUSEPI_API: "ok",
				MUSEPI_LATEST_JSON: latestHasBinary,
			}),
		);

		expect(result.exitCode, result.stderr).toBe(1);
		expect(result.stderr).toContain("The release lists musepi-linux-x64");
		expect(result.stderr).toContain("Retry the installer");
		expect(result.stderr).not.toContain("does not include");
		expect(result.stderr).not.toContain("--ref v0.7.5");
	});

	test("still explains the failure when the release API is unreachable", async () => {
		const bin = await fakeBin({});
		const result = await run(
			["sh", "scripts/install.sh", "--binary"],
			envFor(bin, {
				MUSEPI_ASSET: "fail",
				MUSEPI_API: "down",
				MUSEPI_LATEST_JSON: "",
			}),
		);

		expect(result.exitCode, result.stderr).toBe(1);
		expect(result.stderr).toContain("failed to download musepi-linux-x64");
		expect(result.stderr).toContain("curl: (22)");
		expect(result.stderr).toContain("release API did not answer");
		expect(result.stderr).toContain("sh install.sh --source");
		expect(result.stderr).not.toContain("does not include");
		expect(result.stderr).not.toContain("No recent GitHub release");
	});

	test("a checksum list without this binary points at a release that has one", async () => {
		const bin = await fakeBin({});
		const result = await run(
			["sh", "scripts/install.sh", "--binary"],
			envFor(bin, {
				MUSEPI_ASSET: "ok",
				MUSEPI_SUMS: "empty",
				MUSEPI_API: "ok",
				MUSEPI_LATEST_JSON: latestHasBinary,
			}),
		);

		expect(result.exitCode, result.stderr).toBe(1);
		expect(result.stderr).toContain("SHA256SUMS.txt has no entry for musepi-linux-x64");
		expect(result.stderr).toContain("no usable SHA256SUMS.txt entry for musepi-linux-x64");
		expect(result.stderr).toContain("--ref v0.7.5");
	});
});
