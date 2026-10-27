/**
 * S6l-fix1 §5：make-sfx 脚本的音色解析（不发网络）。
 *
 * 断言：
 * - 音色取自角色包的 `fishVoiceIdEnv`（与会话层同一规则）；
 * - 音色变量为空 → 抛错（脚本据此退出码非 0，不再默默用 Fish 默认音色）；
 * - `--character <id>` 解析；
 * - 反应音输出目录为 `apps/client/public/characters/<id>/sfx`。
 */
import { describe, expect, it } from "vitest";
import { parseCharacterArg, REACTIONS, resolveSfxVoiceId, sfxOutDir } from "../scripts/make-sfx";
import { testPack } from "./helpers/pack";

describe("make-sfx 音色解析（S6l-fix1 §5）", () => {
  const pack = testPack("yuna");

  it("按角色包的 fishVoiceIdEnv 取音色", () => {
    const envName = pack.voice.fishVoiceIdEnv;
    expect(envName).toBe("FISH_VOICE_ID_YUNA");
    expect(resolveSfxVoiceId(pack, { [envName]: "voice-abc" })).toBe("voice-abc");
  });

  it("音色变量为空 → 抛错（脚本退出码非 0）", () => {
    expect(() => resolveSfxVoiceId(pack, {})).toThrow(/FISH_VOICE_ID_YUNA/);
    expect(() => resolveSfxVoiceId(pack, { FISH_VOICE_ID_YUNA: "   " })).toThrow();
  });

  it("parseCharacterArg", () => {
    expect(parseCharacterArg(["node", "make-sfx.ts", "--character", "yuna"])).toBe("yuna");
    expect(parseCharacterArg(["node", "make-sfx.ts"])).toBeUndefined();
  });

  it("sfxOutDir 指向角色目录", () => {
    expect(sfxOutDir("/repo", "yuna")).toBe("/repo/apps/client/public/characters/yuna/sfx");
  });

  it("三条反应音文本保持 S3 原样", () => {
    expect(REACTIONS.map((r) => r.text)).toEqual(["嗯……", "唔……", "这样啊。"]);
  });
});
