import { PermissionManager } from "@musepi/pi-permission";
const pm = new PermissionManager({});
console.log("PermissionManager:", typeof pm.evaluate, "OK");
import { isToolSelectEnabled } from "@musepi/pi-tool-select";
console.log("ToolSelect:", typeof isToolSelectEnabled, "OK");
