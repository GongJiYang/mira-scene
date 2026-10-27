/**
 * 测试用角色包加载（S6b §1）：从仓库 `characters/` 真正加载 pack，避免测试里手写副本。
 * D43：夏凛与隐藏角色机制已删除，只剩忧奈。
 */
import { charactersRoot, loadPack, loadPacks, type Pack } from "../../src/characters/pack";
import { join } from "node:path";

/** 加载指定角色包（现在只有 yuna）。 */
export function testPack(id: "yuna" = "yuna"): Pack {
  return loadPack(join(charactersRoot(), id));
}

/** 加载全部角色包（Map：id → Pack）。 */
export function testPacks(): Map<string, Pack> {
  return loadPacks();
}
