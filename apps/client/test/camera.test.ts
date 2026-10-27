import { describe, expect, it } from "vitest";
import { CAMERA_FACE, CAMERA_PUSH_SCALE, cameraTransform } from "../src/stage/camera";

describe("cameraTransform（§4）", () => {
  it("wide / null 恒为恒等变换", () => {
    expect(cameraTransform("wide", 0)).toEqual({ scale: 1, tx: 0, ty: 0 });
    expect(cameraTransform("wide", 1)).toEqual({ scale: 1, tx: 0, ty: 0 });
    expect(cameraTransform(null, 0.5)).toEqual({ scale: 1, tx: 0, ty: 0 });
  });

  it("close_up：progress 0 为恒等，1 放大到 1.18 并对准脸部", () => {
    expect(cameraTransform("close_up", 0)).toEqual({ scale: 1, tx: 0, ty: 0 });

    const pushed = cameraTransform("close_up", 1);
    expect(pushed.scale).toBeCloseTo(CAMERA_PUSH_SCALE);
    expect(pushed.tx).toBe(0);
    // 脸部下移到画面中心所需的相对位移：(0.5 - 0.28) × 1.18。
    expect(pushed.ty).toBeCloseTo((0.5 - CAMERA_FACE.y) * CAMERA_PUSH_SCALE);
  });

  it("progress 越大越贴近目标，且进度被夹在 0–1", () => {
    expect(cameraTransform("close_up", 0.5).scale).toBeCloseTo(1 + (CAMERA_PUSH_SCALE - 1) * 0.5);
    expect(cameraTransform("close_up", -1).scale).toBe(1);
    expect(cameraTransform("close_up", 5).scale).toBeCloseTo(CAMERA_PUSH_SCALE);
    expect(cameraTransform("close_up", Number.NaN).scale).toBe(1);
  });

  it("scale 随 progress 单调不减", () => {
    let previous = 0;
    for (let p = 0; p <= 1.0001; p += 0.1) {
      const scale = cameraTransform("close_up", p).scale;
      expect(scale).toBeGreaterThanOrEqual(previous);
      previous = scale;
    }
  });
});
