import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { installAudioUnlock } from "./core/audio";
import { bootstrapConnection } from "./core/controller";
import { Live } from "./live/Live";
import { YunaPreview } from "./preview/YunaPreview";
import { DocsApp } from "./docs/DocsApp";
import { ObsApp } from "./obs/ObsApp";

const container = document.getElementById("root");
if (!container) throw new Error("缺少 #root 容器");

const params = new URLSearchParams(window.location.search);

// S6d：`?docs=1` → 开发文档窗口（D21，独立路由，不连服务端）。
// S6a §1.4：`?preview=yuna` → 忧奈 Live2D 预览页（调试用，不连服务端）。
// S6h §2：`?obs=1` → 观测页（独立路由，不连 WebSocket）。
// D43：分层立绘（夏凛 / 旧 Stage 视图）已删除，默认只渲染直播间 UI。
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
} else if (params.get("obs") === "1") {
  createRoot(container).render(
    <StrictMode>
      <ObsApp />
    </StrictMode>,
  );
} else {
  installAudioUnlock();
  bootstrapConnection();
  createRoot(container).render(
    <StrictMode>
      <Live />
    </StrictMode>,
  );
}
