/**
 * S6c-fix1 §6：场景扩写器（真实实现）。
 *
 * - 用户文字代入模板必须用函数替换：`$'`、`$&`、`$$` 等特殊序列不得被展开；
 * - commandcode 分支复用现有适配器（注入假 spawn，不发真实网络/进程请求）。
 */
import { describe, expect, it } from "vitest";
import { renderSceneMessagesForTest, createSceneWriter } from "../src/scene/writer";
import { testPack } from "./helpers/pack";
import type { SpawnFn, SpawnLike } from "../src/adapters/commandcode/commandCodeLlm";
import type { SceneWriteContext } from "../src/ports";

const pack = testPack("yuna");

function ctx(userText: string): SceneWriteContext {
  return { pack, userText, nodeLabel: "下播之后", currentScene: "bedroom" };
}

describe("renderSceneMessages：用户文字代入模板（S6c-fix1 §6）", () => {
  it("用户输入含 $' $& $$ 时原样出现，不被展开", () => {
    const input = "$' $& $$";
    const messages = renderSceneMessagesForTest(ctx(input));
    const user = messages.find((message) => message.role === "user");
    expect(user).toBeDefined();
    expect(user?.content).toContain("$'");
    expect(user?.content).toContain("$&");
    expect(user?.content).toContain("$$");
  });

  it("尖括号被去掉（沿用 S6c §2 的清洗）", () => {
    const messages = renderSceneMessagesForTest(ctx("换<背景>"));
    const user = messages.find((message) => message.role === "user");
    // 模板自带的 <弹幕> 标签保留，用户文字里的尖括号被去掉。
    expect(user?.content).toContain("换背景");
    expect(user?.content).not.toContain("换<背景>");
  });

  it("node_label 与 current_scene 也走函数替换（含 $ 系列不被展开）", () => {
    const messages = renderSceneMessagesForTest({
      pack,
      userText: "海边",
      nodeLabel: "$&",
      currentScene: "$$",
    });
    const user = messages.find((message) => message.role === "user");
    expect(user?.content).toContain("$&");
    expect(user?.content).toContain("$$");
  });
});

describe("createSceneWriter：commandcode 分支（S6c-fix1 §6）", () => {
  function fakeSpawn(text: string): SpawnFn {
    return () => {
      const stdout = (async function* () {
        const line = JSON.stringify({ type: "event", event: { type: "text_delta", delta: text } });
        yield `${line}\n`;
        yield `${JSON.stringify({ type: "result", subtype: "success" })}\n`;
      })();
      const child = {
        stdout,
        stderr: null,
        stdin: { end() {} },
        once(event: string, listener: (...args: unknown[]) => void) {
          if (event === "close") queueMicrotask(() => listener(0, null));
          return child;
        },
        kill() {
          return true;
        },
      };
      return child as unknown as SpawnLike;
    };
  }

  it("走 commandcode 适配器拿到文本", async () => {
    const spec = JSON.stringify({
      accept: true,
      location: "beach",
      time: "sunset",
      lighting: "warm",
      props: ["a", "b"],
      palette: "pink",
      mood: "calm",
      label: "海边",
      note: "note",
    });
    const writer = createSceneWriter({
      provider: "commandcode",
      commandcode: { model: "test-model" },
      spawn: fakeSpawn(spec),
    });
    const out = await writer.write(ctx("换背景到海边"), new AbortController().signal);
    expect(out).toBe(spec);
  });

  it("cmd 出错（非零退出）→ 抛错，且子进程被结束（S6c-fix1 §6）", async () => {
    let killed = false;
    const spawn: SpawnFn = () => {
      const stdout = (async function* () {
        // 不产出任何行。
      })();
      const child = {
        stdout,
        stderr: null,
        stdin: { end() {} },
        once(event: string, listener: (...args: unknown[]) => void) {
          if (event === "close") queueMicrotask(() => listener(1, null));
          return child;
        },
        kill() {
          killed = true;
          return true;
        },
      };
      return child as unknown as SpawnLike;
    };
    const writer = createSceneWriter({ provider: "commandcode", spawn });
    await expect(writer.write(ctx("x"), new AbortController().signal)).rejects.toThrow(/非零退出码/);
    expect(killed).toBe(true);
  });
});
