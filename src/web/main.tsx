import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { App } from "./App.tsx";

const container = document.getElementById("root");
if (container === null) throw new Error("src/web: #root container is missing");

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
