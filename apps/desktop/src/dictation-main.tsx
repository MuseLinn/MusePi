/**
 * Global-dictation HUD entry. The BrowserWindow is non-focusable; this module
 * only mounts the subscribed view and loads its real stylesheets.
 */
import { createRoot } from "react-dom/client";
import { Hud } from "./components/dictation-hud";
import "@musepi/client-core/src/styles/tokens.css";
import "@musepi/client-core/src/styles/overlay-fallback.css";
import "./styles/dictation.css";

export { Hud } from "./components/dictation-hud";

const root = document.getElementById("root");
if (root) createRoot(root).render(<Hud />);
