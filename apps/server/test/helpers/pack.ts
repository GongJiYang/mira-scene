/**
 * 测试用角色包加载（S6b §1）：从仓库 `characters/` 真正加载 pack，避免测试里手写副本。
 */
import { charactersRoot, loadPack, loadPacks, type Pack } from "../../src/characters/pack";
import { join } from "node:path";

/** 加载指定角色包。 */
export function testPack(id: "rin" | "yuna" = "rin"): Pack {
  return loadPack(join(charactersRoot(), id));
}

/** 加载全部角色包（Map：id → Pack）。 */
export function testPacks(): Map<string, Pack> {
  return loadPacks();
}

/**
 * S6f §1：仓库里 rin 是隐藏角色（hidden: true），SessionManager 会拒绝连接。
 * 依赖夏凛的 SessionManager 用例用本 helper——显式加载隐藏包（把 rin 的 hidden
 * 覆盖为 false，等效于「改成显式加载隐藏包」），yuna 保持原样。
 */
export function testPacksWithRinVisible(): Map<string, Pack> {
  const packs = loadPacks();
  const rin = packs.get("rin");
  if (rin) packs.set("rin", { ...rin, hidden: false });
  return packs;
}

/** S6f §1：只有 yuna 的 packs Map（缺省角色；不加载隐藏包）。 */
export function testPacksYunaOnly(): Map<string, Pack> {
  const packs = loadPacks();
  packs.delete("rin");
  return packs;
}
