import { createRoot } from "react-dom/client";
import { App } from "./app";
import "./styles/tokens.css";
import "./styles/base.css";
import "./i18n";

// Desktop web entry (index.html). The Capacitor shell redirects to mobile.html
// (see the inline script in index.html), so this bundle never touches
// Capacitor plugins — mobile-only logic lives in ./mobile.tsx.

const root = document.getElementById("root");
if (!root) throw new Error("missing #root element");
createRoot(root).render(<App />);
