import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { docsPlugin } from "./vite/docsPlugin";

// 端口可用环境变量覆盖：端到端测试用独立端口，避免占用开发者本机的 5173 / 8787。
const serverPort = Number(process.env.MIRA_SERVER_PORT ?? 8787);
const clientPort = Number(process.env.MIRA_CLIENT_PORT ?? 5173);

export default defineConfig({
  plugins: [docsPlugin(), react()],
  resolve: {
    alias: {
      // S6a §1.2：直接引用 CubismWebFramework 源码，不改框架源码。
      "@cubism": fileURLToPath(new URL("./vendor/CubismWebFramework/src", import.meta.url)),
    },
  },
  server: {
    port: clientPort,
    strictPort: true,
    proxy: {
      "/ws": {
        target: `ws://localhost:${serverPort}`,
        ws: true,
      },
      // 握手令牌（Q12）：与生产同源部署保持一致的前缀。
      "/session-token": {
        target: `http://localhost:${serverPort}`,
      },
    },
  },
});
