import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { installAudioUnlock } from "./core/audio";
import { bootstrapConnection } from "./core/controller";
import { Live } from "./live/Live";
import { YunaPreview } from "./preview/YunaPreview";
import { DocsApp } from "./docs/DocsApp";

const container = document.getElementById("root");
if (!container) throw new Error("缺少 #root 容器");

const params = new URLSearchParams(window.location.search);

// S6d：`?docs=1` → 开发文档窗口（D21，独立路由，不连服务端）。
// S6a §1.4：`?preview=yuna` → 忧奈 Live2D 预览页（调试用，不连服务端）。
// S6b §4：默认渲染新直播间 UI；`?legacy=1` 保留旧的 Stage 视图。
if (params.get("docs") === "1") {
  createRoot(container).render(
    <StrictMode>
      <DocsApp />
    </StrictMode>,
  );
} else if (params.get("preview") === "yuna") {
  createRoot(container).render(
    <StrictMode>
      <YunaPreview />
    </StrictMode>,
  );
} else {
  installAudioUnlock();
  bootstrapConnection();

  const legacy = params.get("legacy") === "1";
  createRoot(container).render(<StrictMode>{legacy ? <App /> : <Live />}</StrictMode>);
}
