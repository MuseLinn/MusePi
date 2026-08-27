import { createRoot } from "react-dom/client";
import * as React from "react";
import { App } from "./app";
import "./styles/tokens.css";
import "./styles/base.css";
import "./i18n";

// Desktop web entry (index.html). The Capacitor shell redirects to mobile.html
// (see the inline script in index.html), so this bundle never touches
// Capacitor plugins — mobile-only logic lives in ./mobile.tsx.

// Slot-host contract: compiled extension components (daemon
// extension-artifact-compiler) reference React through window.MusePiReact so
// they bind to the HOST's react instance. The desktop-web bundle IS a React
// host (it renders the session), so it exposes its instance the same way the
// GUI's slot-host does. The compat slot host (injected by `musepi serve`)
// then blob-imports extension components against this instance.
(window as unknown as { MusePiReact?: unknown }).MusePiReact = React;

const root = document.getElementById("root");
if (!root) throw new Error("missing #root element");
createRoot(root).render(<App />);
