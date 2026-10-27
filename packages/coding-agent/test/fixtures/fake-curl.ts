const argsFile = process.env.FAKE_CURL_ARGS_FILE;
const bodyFile = process.env.FAKE_CURL_BODY_FILE;
const args = process.argv.slice(2);
if (!argsFile || !bodyFile) throw new Error("argsFile and bodyFile are required");
await Bun.write(argsFile, `${args.join("\n")}\n`);
await Bun.write(bodyFile, await new Response(Bun.stdin.stream()).text());
