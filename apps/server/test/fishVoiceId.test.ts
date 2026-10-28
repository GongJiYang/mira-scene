import { describe, expect, it } from "vitest";
import { resolveFishVoiceId } from "../src/characters/pack";
import { testPack } from "./helpers/pack";

/**
 * freeze-fix9 §4：录音脚本按角色包 `voice.fishVoiceIdEnv` 取音色。
 * 纯函数：有值 → 用；无 / 空 / 未定义 → 抛错（不得静默用默认音色）。
 * 忧奈的变量名来自角色包（`FISH_VOICE_ID_YUNA`）。
 */
describe("resolveFishVoiceId（freeze-fix9 §4）", () => {
  it("返回该角色包 fishVoiceIdEnv 指向的环境变量值（去除首尾空白）", () => {
    const pack = testPack();
    const envName = pack.voice.fishVoiceIdEnv;
    expect(envName).toBe("FISH_VOICE_ID_YUNA");
    const id = resolveFishVoiceId(pack, { [envName]: "  voice-yuna-xyz  " });
    expect(id).toBe("voice-yuna-xyz");
  });

  it("环境变量缺失 / 为空 / 纯空白 → 抛错（不回落默认音色）", () => {
    const pack = testPack();
    const envName = pack.voice.fishVoiceIdEnv;
    expect(() => resolveFishVoiceId(pack, {})).toThrowError(/FISH_VOICE_ID_YUNA/);
    expect(() => resolveFishVoiceId(pack, { [envName]: "" })).toThrowError(/FISH_VOICE_ID_YUNA/);
    expect(() => resolveFishVoiceId(pack, { [envName]: "   " })).toThrowError(/FISH_VOICE_ID_YUNA/);
  });

  it("不会回落到通用 FISH_VOICE_ID（只认角色包指定的变量）", () => {
    const pack = testPack();
    expect(() => resolveFishVoiceId(pack, { FISH_VOICE_ID: "generic-male" })).toThrowError(
      /FISH_VOICE_ID_YUNA/,
    );
  });
});
