# S6a-fix1：忧奈参数层的 4 个问题（Claude 审查结论）

> 前置：`docs/tasks/s6a.md` 的铁律全部继续有效（冲突停下报告；Key 不打印；不准 commit；不碰 live2d-pipeline / skills）。
> 授权范围：`apps/client/src/render/live2d/yunaParams.ts`、`apps/client/src/render/live2d/cubism/yunaRenderer.ts`、`apps/client/src/preview/YunaPreview.tsx`、`apps/client/test/yunaParams.test.ts`、`e2e/yuna-preview.spec.ts`、追加 `docs/tasks/s6a-report.md` 末尾一节「fix1」。

## 1. 切换情绪后旧参数残留（bug）
- 现状：`yunaParams` 只输出当前情绪表里的键；外壳每帧不重置参数，所以 sad → calm 后 `ParamBrowLAngle/RAngle`、`ParamBrowLY/RY`、`ParamEyeLSmile/RSmile`、`ParamShy` 会停在上一个情绪的值。
- 改法（纯函数里解决，不在外壳里补）：`yunaParams` 的输出**始终包含 `EMOTION_PARAMS` 所有情绪用到的键的并集**，当前情绪没用到的键给 0（模型默认）。
- 测试：fast-check 属性——任意两组输入，输出的键集合完全相同；calm 的这些键全是 0。

## 2. 自动眨眼被覆盖（bug）
- 现状：外壳先让 `CubismEyeBlink` 写 `ParamEyeLOpen`，随后 `setEyeOpen(applyEyeOpen(blinkOpen))` 用预览页里**常量 1** 的 `blinkOpen` 覆盖掉，自动眨眼永远看不到，只有手动按钮有效。
- 改法：外壳在 EyeBlink 之后**读出**它写的值（0–1），把它和手动眨眼的值相乘（纯函数 `combineBlink(auto, manual)`），再交给 `applyEyeOpen`。决策仍在纯函数里，外壳只读写。
- 每帧 `model.update()` 只调用一次：顺序改为 写参数 → EyeBlink → 读出并写回最终睁眼值 → 物理 → update → draw。
- 测试：`combineBlink` 单测；e2e 里等 6 秒，采样 `ParamEyeLOpen`（可通过预览页暴露的只读调试值，如 `data-eye-open` 属性）至少出现一次 < 0.3。

## 3. 情绪切换没有平滑（不符合 s6a §1.3）
- `approach()` 写了但没被使用。新增纯函数 `approachParams(current, target, dt)`（逐键调用 `approach`，键集合以 target 为准），外壳保存上一帧参数，每帧向 `yunaParams` 的结果逼近（约 0.25 秒到位，按 dt 换算比例）。呼吸、口型、视线不需要平滑，只对情绪键做。
- 测试：`approachParams` 单测（dt=0 不变、dt=1 直达、键集合等于 target）。

## 4. 单一出处
- `yunaParams.ts` 里的 `MOUTH_OPEN` 删掉，改为从 `state/performance.ts` 导入（s6a §1.3 写的是「沿用」）。

## 5. sad 不够明显（调参）
- 截图里 sad 和 calm 只差一点眉形。在舒适区间内加大 sad 的眉和嘴角数值（可加 `ParamEyeLOpen/ROpen` 略低），让 sad 与 calm 的脸部截图肉眼可区分。其他情绪不动。截图更新到 `e2e/out/emotion-*.png`。

## 验收
`pnpm test`、`pnpm typecheck`、`pnpm e2e` 通过；删除所有调试用 spec（`dbg`/`probe` 一类）。报告追加「fix1」一节：改了什么、测试数、sad 新数值。
