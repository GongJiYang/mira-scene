/**
 * 音量读取的端口 / 适配器（D34 落地方案）。
 *
 * - `AudioLevelSource`：端口。渲染层只读「口型形状」，永远不接触 Web Audio。
 * - `createAnalyserLevelSource`：生产适配器，用 AnalyserNode 读时域数据算 RMS。
 * - 测试用假的 `AudioLevelSource`（返回固定 / 脚本化音量），不依赖浏览器。
 *
 * 接线方式（§1）：`source → analyser → destination`，fftSize = 512。
 */

/** §1：fftSize 取 512。 */
export const FFT_SIZE = 512;

/** 端口：每一帧读一次当前音量（0–1 的 RMS）。 */
export type AudioLevelSource = {
  /** 浏览器能否提供 AnalyserNode；false 时外壳退回 small/open 交替。 */
  readonly available: boolean;
  /** 当前 RMS；拿不到数据时为 0。 */
  read(): number;
};

/** 纯函数：时域数据（-1..1）→ RMS。 */
export function rmsFromTimeDomain(samples: Float32Array): number {
  const length = samples.length;
  if (length === 0) return 0;
  let sum = 0;
  for (let index = 0; index < length; index += 1) {
    const value = samples[index] ?? 0;
    sum += value * value;
  }
  const rms = Math.sqrt(sum / length);
  return Number.isFinite(rms) ? rms : 0;
}

export type AnalyserLevelSource = {
  /** 把音频接到这里，再把 `node` 接到 destination（source → analyser → destination）。 */
  readonly node: AnalyserNode;
  readonly source: AudioLevelSource;
};

/** 生产适配器：包一个 AnalyserNode，每帧读时域数据和算 RMS。 */
export function createAnalyserLevelSource(context: BaseAudioContext, fftSize: number = FFT_SIZE): AnalyserLevelSource {
  const analyser = context.createAnalyser();
  analyser.fftSize = fftSize;
  const buffer = new Float32Array(analyser.fftSize);

  return {
    node: analyser,
    source: {
      available: true,
      read() {
        analyser.getFloatTimeDomainData(buffer);
        return rmsFromTimeDomain(buffer);
      },
    },
  };
}
