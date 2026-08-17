import { createRoot } from "react-dom/client";
import { App } from "./app";
import "@musepi/collab-web/src/styles/tokens.css";
import "@musepi/collab-web/src/styles/base.css";
import "@musepi/collab-web/src/components/shell/shell.css";
import "@musepi/collab-web/src/components/transcript/transcript.css";
import "@musepi/collab-web/src/components/agents/agents.css";
import "@musepi/collab-web/src/tool-render/tool-render.css";
import "./styles/fonts.css";
import "./styles/gui.css";
import "./styles/tailwind.out.css";

const root = document.getElementById("root");
if (!root) throw new Error("missing #root element");
createRoot(root).render(<App />);
