import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";
// tokens.css kept during transition — existing components still reference its
// custom properties (--bg-canvas, --text-body, --border-hairline, etc.).
// Remove this import once every component is migrated to shadcn tokens.
import "./styles/tokens.css";
import { ThemeProvider } from "./components/theme-provider";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ThemeProvider>
      <App />
    </ThemeProvider>
  </React.StrictMode>,
);
