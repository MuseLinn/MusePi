import * as fs from "node:fs";
import * as path from "node:path";
import { disposePluginPrimitives } from "./src/extensibility/plugins/runtime/cordis-primitives";
import { loadSessionPlugins } from "./src/extensibility/plugins/runtime/session-loader";
import { EventBus } from "./src/utils/event-bus";

const log = (m: string) => process.stderr.write(m + "\n");
setTimeout(() => {
	log("GLOBAL TIMEOUT");
	process.exit(3);
}, 6000);
const dir = fs.mkdtempSync(path.join(process.env.TEMP ?? "/tmp", "probe8-"));
const entry = path.join(dir, "ext.ts");
fs.writeFileSync(entry, "export default function (pi: any) { pi.effect(() => {}); }");
log("loading");
const result = await loadSessionPlugins([entry], dir, new EventBus());
log("loaded fibers=" + Boolean(result.extensions[0]?.fiber));
await disposePluginPrimitives(result.extensions[0]!);
log("disposed");
process.exit(0);
