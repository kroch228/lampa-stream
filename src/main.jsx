import React from "react";
import ReactDOM from "react-dom/client";
// Web shim: defines window.electron via fetch() when running outside Electron
// (in Electron, preload.js already set it, so the shim no-ops). Imported before
// App so App's secureGet/tmdbProxyGet calls resolve to the web API.
import "./web/shim";
import { ensureSiteGate } from "./web/gate";
import App from "./App";
import "./styles/global.css";

// Web only: gate on the site password before mounting the app. On desktop this
// resolves immediately (no VITE_SITE_PWD_HASH → no gate).
ensureSiteGate().finally(() => {
  ReactDOM.createRoot(document.getElementById("root")).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
});
