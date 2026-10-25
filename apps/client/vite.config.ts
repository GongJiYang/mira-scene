import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/ws": {
        target: "ws://localhost:8787",
        ws: true,
      },
      // 握手令牌（Q12）：与生产同源部署保持一致的前缀。
      "/session-token": {
        target: "http://localhost:8787",
      },
    },
  },
});
