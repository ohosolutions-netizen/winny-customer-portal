import React from "react";
import { createRoot } from "react-dom/client";
import "./styles/portal.css";
import "./styles/application-progress.css";
import "./styles/family-travellers.css";
import App from "./App.jsx";

// No React.StrictMode: the original ran init() exactly once; StrictMode would
// double-invoke effects and re-run the Zoho boot sequence in dev.
createRoot(document.getElementById("root")).render(<App />);
