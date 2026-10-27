import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { installAudioUnlock } from "./core/audio";
import { bootstrapConnection } from "./core/controller";
import { YunaPreview } from "./preview/YunaPreview";
import { DocsApp } from "./docs/DocsApp";

const container = document.getElementById("root");
if (!container) throw new Error("缺少 #root 容器");

// S6a §1.4：URL 带 `?preview=yuna` 时渲染忧奈 Live2D 预览页，否则照旧渲染现有 App。
const search = new URLSearchParams(window.location.search);
const preview = search.get("preview");
if (search.get("docs") === "1") {
  // S6d：独立路由 `?docs=1`，不依赖直播间 UI。
  createRoot(container).render(
    <StrictMode>
      <DocsApp />
    </StrictMode>,
  );
} else if (preview === "yuna") {
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
