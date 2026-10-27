# Live2D Cubism Core 许可说明

- 文件：`live2dcubismcore.min.js`
- 来源 URL：https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js
- 下载日期：2026-10-27
- 版本：Cubism Core **5.1.0**（运行时 `Version.csmGetVersion()` 返回 `0x05010000`）
- 许可：Live2D Proprietary Software License Agreement
  （https://www.live2d.com/eula/live2d-proprietary-software-license-agreement_en.html）
- Copyright (C) 2019 Live2D Inc. All rights reserved.

本文件是 Live2D Cubism SDK for Web 的「Redistributable Code」，随应用本地分发，
页面通过本地 `<script>` 加载（不联网）。

## 与框架版本的对应关系

该 CDN 提供的 Core 为 **5.1.0**。实测它与 CubismWebFramework 的 `5-r.5` **不兼容**
（`csmGetMocVersion` 参数个数、`Model.offscreens` 字段不同），与 **`5-r.4`** 匹配。
因此 `apps/client/vendor/CubismWebFramework/` 固定为 **5-r.4**。详见 `docs/tasks/s6a-report.md`。
