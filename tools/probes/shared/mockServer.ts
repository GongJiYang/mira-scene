import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export type MockServerOptions = {
  /** ASR 假接口返回的文本。 */
  asrText?: string;
  /** TTS 假接口返回的音频字节。 */
  ttsAudio?: Buffer;
};

export type MockServer = {
  baseUrl: string;
  close: () => Promise<void>;
};

const sleep = (ms: number): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
};

function readBody(request: IncomingMessage): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  const chunks: Buffer[] = [];
  request.on("data", (chunk: Buffer) => chunks.push(chunk));
  request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  request.on("error", reject);
  return promise;
}

/** 按格式生成一段假的模型输出。 */
function cannedContent(format: string | undefined): string {
  if (format === "b") {
    return JSON.stringify([
      { say: "雨还在下。", emotion: "calm", suggest: null, advance: null },
      { say: "先坐吧，靠窗那桌干净。", emotion: "calm", suggest: null, advance: "probe" },
    ]);
  }
  if (format === "e") {
    return "[calm]雨还在下。<act:glance_window>\n[calm]先坐吧，靠窗那桌干净。<advance:probe>\n";
  }
  return [
    '{"say":"雨还在下。","emotion":"calm","suggest":null,"advance":null}',
    '{"say":"先坐吧，靠窗那桌干净。","emotion":"calm","suggest":null,"advance":"probe"}',
    "",
  ].join("\n");
}

async function streamChat(response: ServerResponse, format: string | undefined): Promise<void> {
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  const content = cannedContent(format);
  const id = `mock-${Date.now()}`;
  await sleep(80);
  // 按 6 个字切块，模拟真实 token 流。
  for (let index = 0; index < content.length; index += 6) {
    const delta = content.slice(index, index + 6);
    response.write(
      `data: ${JSON.stringify({
        id,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: "mock-model",
        choices: [{ index: 0, delta: { content: delta }, finish_reason: null }],
      })}\n\n`,
    );
    await sleep(15);
  }
  response.write(
    `data: ${JSON.stringify({
      id,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: "mock-model",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: {
        prompt_tokens: 640,
        completion_tokens: 60,
        total_tokens: 700,
        prompt_tokens_details: { cached_tokens: 0 },
        prompt_cache_hit_tokens: 0,
        prompt_cache_miss_tokens: 640,
      },
    })}\n\n`,
  );
  response.write("data: [DONE]\n\n");
  response.end();
}

/** 本地假服务：OpenAI 兼容 chat + Fish ASR/TTS，供 --mock 验证全流程。 */
export async function startMockServer(options: MockServerOptions = {}): Promise<MockServer> {
  const server: Server = createServer((request, response) => {
    const url = request.url ?? "";
    void (async () => {
      if (url.endsWith("/chat/completions")) {
        await readBody(request);
        await streamChat(response, request.headers["x-probe-format"] as string | undefined);
        return;
      }
      if (url.endsWith("/asr")) {
        await readBody(request);
        await sleep(120);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            text: options.asrText ?? "雨还在下",
            duration: 3.2,
            segments: [],
            language_code: "zh",
            language: "Chinese",
          }),
        );
        return;
      }
      if (url.endsWith("/tts")) {
        await readBody(request);
        const audio = options.ttsAudio ?? Buffer.alloc(0);
        response.writeHead(200, { "content-type": "audio/mpeg" });
        const half = Math.ceil(audio.length / 2);
        response.write(audio.subarray(0, half));
        await sleep(60);
        response.write(audio.subarray(half));
        response.end();
        return;
      }
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: 404, message: `mock 没有这个路由：${url}` }));
    })().catch((error: unknown) => {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: 500, message: String(error) }));
    });
  });

  const listening = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", listening.resolve);
  await listening.promise;
  const address = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => {
      const closed = Promise.withResolvers<void>();
      server.close((error) => (error ? closed.reject(error) : closed.resolve()));
      return closed.promise;
    },
  };
}
