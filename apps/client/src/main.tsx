import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { installAudioUnlock } from "./core/audio";
import { bootstrapConnection } from "./core/controller";
import { YunaPreview } from "./preview/YunaPreview";

const container = document.getElementById("root");
if (!container) throw new Error("缺少 #root 容器");

// S6a §1.4：URL 带 `?preview=yuna` 时渲染忧奈 Live2D 预览页，否则照旧渲染现有 App。
const preview = new URLSearchParams(window.location.search).get("preview");
if (preview === "yuna") {
  createRoot(container).render(
    <StrictMode>
      <YunaPreview />
    </StrictMode>,
  );
} else {
  installAudioUnlock();
  bootstrapConnection();

  createRoot(container).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
