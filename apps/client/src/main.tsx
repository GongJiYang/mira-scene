import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { installAudioUnlock } from "./core/audio";
import { bootstrapConnection } from "./core/controller";

const container = document.getElementById("root");
if (!container) throw new Error("缺少 #root 容器");

installAudioUnlock();
bootstrapConnection();

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
