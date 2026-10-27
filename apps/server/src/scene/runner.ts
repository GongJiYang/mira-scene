/**
 * S6c §2–§4：换后台任务执行器（编排层）。
 *
 * 流程：检测命中 → 判定 admission → 扩写（SceneWriterPort）→ 拼提示词 → 生图（两张并行）→ 下发 scene_status。
 * 打断不取消任务（与 D27 一致）；切频道由会话层中止本执行器的 signal。
 *
 * S6c-fix1 §3：每个任务一个 `AbortController`，与会话的 `sceneController` 联动；
 * `SCENE_TIMEOUT_MS` 到点即 abort（扩写与两张生图一起取消）→ `failed`。两张图任何一张失败，
 * 立即 abort 另一张（不再白白付费）。
 *
 * 本模块只做编排，不做 I/O（生图 / 扩写由注入的端口完成）。
 */
import { existsSync } from "node:fs";
import { isAbortError, throwIfAborted } from "../abort";
import { resolveClientAssetPath, type Pack } from "../characters/pack";
import type { SceneWriterPort } from "../ports";
import { composeScenePrompt } from "./prompt";
import { parseSceneSpec, type SceneSpec } from "./spec";
import { SCENE_TIMEOUT_MS, type SceneJobEvent } from "./job";
import { generateImage, type ImageGenOptions } from "../adapters/media/imageGen";

/** 生图结果（两张并行，一张失败即整体失败）。 */
export type SceneImages = { desktop: string; mobile: string };

/**
 * S6c §6：Mock 模式下生图的替身——返回角色包目录里的预置测试图 URL。
 * 扩展名按实际存在的文件决定（yuna 为 `.jpg`，rin 为 `.png`），找不到时退回 `.jpg`。
 */
function mockSceneUrls(pack: Pack): SceneImages {
  const pick = (suffix: string): string => {
    for (const ext of ["jpg", "png"] as const) {
      const url = `/characters/${pack.id}/test-scene-${suffix}.${ext}`;
      if (existsSync(resolveClientAssetPath(url))) return url;
    }
    return `/characters/${pack.id}/test-scene-${suffix}.jpg`;
  };
  return { desktop: pick("desktop"), mobile: pick("mobile") };
}

/** 换背景任务的依赖（由会话层注入）。 */
export type SceneRunnerDeps = {
  /** 场景扩写端口（Mock 或真实）。 */
  writer: SceneWriterPort;
  /** 生图参数（不含 prompt / size / media，由本模块按 spec 填）。 */
  image: Omit<ImageGenOptions, "prompt" | "size" | "media" | "signal">;
  /** 当前背景作为参考图的路径（桌面 / 手机）。 */
  referencePaths: { desktop: string; mobile: string };
  /** 当前剧情阶段 label。 */
  nodeLabel: string;
  /** 当前背景描述。 */
  currentScene: string;
  /** 下发 scene_status 消息。 */
  emit: (event: SceneJobEvent, payload: { jobId: string; status: string; label?: string; urls?: SceneImages; note?: string }) => void;
  /** 记录日志。 */
  log?: (event: string, detail?: unknown) => void;
  /** 服务端时钟（默认 Date.now）。 */
  now?: () => number;
  /** 生图单张超时（默认 60s）。 */
  imageTimeoutMs?: number;
  /** 从发起到两张图都就绪的总超时（默认 90s）。 */
  totalTimeoutMs?: number;
};

/** 执行结果（供会话层决定台词与状态）。 */
export type SceneRunOutcome =
  | { kind: "ready"; label: string; urls: SceneImages }
  | { kind: "rejected"; note: string }
  | { kind: "failed"; error: string };

/**
 * 执行一次换背景任务。
 * 调用方需先通过 `admitSceneJob` 判定允许发起；本函数假设已获准。
 *
 * `signal` 是会话级取消（切频道 / 会话回收）。本函数内部再建一个任务级 controller，
 * 与 `signal` 联动并叠加 `totalTimeoutMs`：到点 abort 全部子任务。
 */
export async function runSceneJob(
  pack: Pack,
  userText: string,
  jobId: string,
  deps: SceneRunnerDeps,
  signal: AbortSignal,
): Promise<SceneRunOutcome> {
  const now = deps.now ?? Date.now;
  const totalTimeoutMs = deps.totalTimeoutMs ?? SCENE_TIMEOUT_MS;
  const imageTimeoutMs = deps.imageTimeoutMs;

  // S6c-fix1 §3：任务级 controller，与会话 signal 联动；总超时到点即 abort（扩写 + 两张图一起取消）。
  const taskController = new AbortController();
  const taskSignal = AbortSignal.any([signal, taskController.signal]);
  const onSessionAbort = (): void => taskController.abort();
  if (signal.aborted) taskController.abort();
  else signal.addEventListener("abort", onSessionAbort, { once: true });
  const timeoutTimer = setTimeout(() => taskController.abort(), totalTimeoutMs);
  timeoutTimer.unref?.();

  // 会话层通过 emit 同步维护自己的 sceneJob 状态；本函数内不再维护局部 state（S6c-fix1 §8）。
  const emit = (
    event: SceneJobEvent,
    payload: { jobId: string; status: string; label?: string; urls?: SceneImages; note?: string },
  ): void => {
    deps.emit(event, payload);
  };

  try {
    // 1. 请求（writing）
    emit({ type: "request", jobId, at: now() }, { jobId, status: "writing" });

    // 2. 扩写
    let spec: SceneSpec;
    try {
      throwIfAborted(taskSignal);
      const raw = await deps.writer.write(
        { pack, userText, nodeLabel: deps.nodeLabel, currentScene: deps.currentScene },
        taskSignal,
      );
      const parsed = parseSceneSpec(raw);
      if (parsed.kind === "invalid") {
        emit({ type: "failed", jobId, error: parsed.reason, at: now() }, { jobId, status: "failed" });
        return { kind: "failed", error: parsed.reason };
      }
      if (parsed.kind === "rejected") {
        emit({ type: "rejected", jobId, note: parsed.note, at: now() }, { jobId, status: "rejected", note: parsed.note });
        return { kind: "rejected", note: parsed.note };
      }
      spec = parsed.spec;
    } catch (error) {
      const message = isAbortError(error) ? "aborted" : error instanceof Error ? error.message : String(error);
      emit({ type: "failed", jobId, error: message, at: now() }, { jobId, status: "failed" });
      return { kind: "failed", error: message };
    }

    // 3. 扩写完成 → generating
    emit({ type: "written", jobId, label: spec.label, at: now() }, { jobId, status: "generating", label: spec.label });

    // 4. 生图（两张并行，一张失败即整体失败）
    // Mock 模式（无 image 配置）：跳过生图，直接返回角色包目录下的预置测试图 URL（S6c §6）。
    if (deps.image === undefined) {
      const urls = mockSceneUrls(pack);
      emit({ type: "ready", jobId, urls, at: now() }, { jobId, status: "ready", label: spec.label, urls });
      return { kind: "ready", label: spec.label, urls };
    }

    const genOneWithAbort = async (device: "desktop" | "mobile"): Promise<string> => {
      const composed = composeScenePrompt(spec, pack, device);
      const result = await generateImage({
        ...(deps.image as NonNullable<SceneRunnerDeps["image"]>),
        prompt: composed.prompt,
        media: { type: "photo", id: `scene-${jobId}-${device}` },
        timeoutMs: imageTimeoutMs,
        signal: AbortSignal.any([taskSignal, otherController.signal]),
        reference: { path: deps.referencePaths[device] },
        size: composed.size,
      });
      return result.url;
    };

    // S6c-fix1 §3：一张失败立即 abort 另一张（不再白白付费）。
    const otherController = new AbortController();
    const abortOther = (): void => otherController.abort();
    try {
      const [desktop, mobile] = await Promise.all([
        genOneWithAbort("desktop"),
        genOneWithAbort("mobile"),
      ]);
      const urls = { desktop, mobile };
      emit({ type: "ready", jobId, urls, at: now() }, { jobId, status: "ready", label: spec.label, urls });
      return { kind: "ready", label: spec.label, urls };
    } catch (error) {
      abortOther();
      const message = isAbortError(error) ? "aborted" : error instanceof Error ? error.message : String(error);
      emit({ type: "failed", jobId, error: message, at: now() }, { jobId, status: "failed" });
      return { kind: "failed", error: message };
    }
  } finally {
    clearTimeout(timeoutTimer);
    signal.removeEventListener("abort", onSessionAbort);
  }
}
