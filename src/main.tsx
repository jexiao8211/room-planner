import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";
import { restoreViewAfterReload, startAutoUpdate } from "./ui/autoUpdate";

// After an automatic update the page comes back on the same tab, selection and camera view.
restoreViewAfterReload();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

startAutoUpdate();
