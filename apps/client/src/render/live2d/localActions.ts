/**
 * S6m §2：客户端本地新动作的纯函数曲线（参数法一版）。
 *
 * 新动作不进协议、不给 LLM，只在客户端「动作表」里点一下预览。三个动作：
 * - `tail_wag`（摇尾巴）：物理**后覆盖** `ParamTailX1/X2/X3` 依次相位差的正弦；
 * - `ear_flick`（抖耳朵）：物理**后覆盖** `ParamEarsLY2/RY2` 两次快速弹动；
 * - `sway`（身体晃）：写物理**输入** `ParamBodyAngleZ` / `ParamAngleZ`（经 `clampParam`），
 *   让物理带动头发 / 耳朵 / 尾巴。
 *
 * freeze-fix9 §1：「挥手」已移除——`ParamBoomR` / `ParamForeamR` / `ParamHandR` 在这套皮套里
 * 都是物理输出，实测物理后覆盖也无法把右臂抬起（臂区竖直重心 / 顶边变化 < 1px，见
 * `docs/tasks/freeze-fix9-report.md` 的实测表）。动作表改用摇尾巴。
 *
 * 为什么手 / 尾 / 耳要「物理后覆盖」：它们在 `yuna.physics3.json` 里全是物理**输出**，
 * 在物理之前写会被物理覆盖掉（D46③）。外层在物理更新后、模型 update 前按权重混合写入。
 *
 * 纯函数：不依赖 React / DOM / 时钟。返回「后覆盖目标 / 物理输入 / 归一化进度」三部分，
 * 范围截断统一交给模型运行时（读 Cubism 的 min/max），本文件只给**目标值**。
 */
import { clampParam } from "./yunaParams";

export type LocalActionId = "tail_wag" | "ear_flick" | "sway";

/** 本地动作的时长（秒）。 */
export const LOCAL_ACTION_DURATION_SEC: Record<LocalActionId, number> = {
  tail_wag: 2.5,
  ear_flick: 0.8,
  sway: 2.5,
};

/** 摇尾幅度（范围的 70%）与频率（Hz）。 */
export const TAIL_AMPLITUDE = 0.7;
export const TAIL_FREQ_HZ = 1.8;
/** 摇尾相邻节段相位差（秒）。 */
export const TAIL_PHASE_STEP_SEC = 0.15;

/** 抖耳朵一次弹动的时长（秒）；动作内两次。 */
export const EAR_FLICK_BURST_SEC = 0.15;

/** 身体晃的物理输入幅度（度）：身体 ±6、头部 ±4；频率 0.8Hz。 */
export const SWAY_BODY_AMPLITUDE = 6;
export const SWAY_HEAD_AMPLITUDE = 4;
export const SWAY_FREQ_HZ = 0.8;

const TWO_PI = Math.PI * 2;

/** 动作结果：`postPhysics` 物理后覆盖目标（wave/tail_wag/ear_flick）；`input` 物理输入（sway）；`progress` 0–1。 */
export type LocalActionSample = {
  postPhysics: Record<string, number>;
  input: Record<string, number>;
  progress: number;
};

const EMPTY_SAMPLE: LocalActionSample = { postPhysics: {}, input: {}, progress: 0 };

/**
 * 抖耳朵的两次弹动包络：每次从 0 冲到 1 再回 0（半正弦），两次间隔以 `<burst>` 为周期。
 * `elapsedSec ∈ [0, duration]`；位于一次弹动内返回 `sin(π * u)`（u 为弹动内进度）。
 */
function earFlickPulse(elapsedSec: number, durationSec: number): number {
  if (elapsedSec < 0 || elapsedSec >= durationSec) return 0;
  // 两次弹动均匀铺在总时长内：周期 = duration/2。
  const period = durationSec / 2;
  const local = elapsedSec % period;
  if (local >= EAR_FLICK_BURST_SEC) return 0;
  return Math.sin((Math.PI * local) / EAR_FLICK_BURST_SEC);
}

/**
 * `localActionSample(action, elapsedSec)`：某一时刻该动作的三部分采样。
 * 越界时间（<0 或 ≥ 时长）返回空（不写任何参数）。
 */
export function localActionSample(action: LocalActionId, elapsedSec: number): LocalActionSample {
  const duration = LOCAL_ACTION_DURATION_SEC[action];
  if (!Number.isFinite(elapsedSec) || elapsedSec < 0 || elapsedSec >= duration) return EMPTY_SAMPLE;
  const t = elapsedSec;
  const progress = duration > 0 ? t / duration : 0;

  switch (action) {
    case "tail_wag":
      return {
        postPhysics: {
          ParamTailX1: TAIL_AMPLITUDE * Math.sin(TWO_PI * TAIL_FREQ_HZ * t),
          ParamTailX2: TAIL_AMPLITUDE * Math.sin(TWO_PI * TAIL_FREQ_HZ * t - TAIL_PHASE_STEP_SEC),
          ParamTailX3: TAIL_AMPLITUDE * Math.sin(TWO_PI * TAIL_FREQ_HZ * t - 2 * TAIL_PHASE_STEP_SEC),
        },
        input: {},
        progress,
      };
    case "ear_flick": {
      const pulse = earFlickPulse(t, duration);
      return {
        postPhysics: { ParamEarsLY2: pulse, ParamEarsRY2: pulse },
        input: {},
        progress,
      };
    }
    case "sway": {
      const wave = Math.sin(TWO_PI * SWAY_FREQ_HZ * t);
      // 物理输入：经 clampParam 截断到舒适区间（唯一限幅出处）。
      return {
        postPhysics: {},
        input: {
          ParamBodyAngleZ: clampParam("ParamBodyAngleZ", SWAY_BODY_AMPLITUDE * wave),
          ParamAngleZ: clampParam("ParamAngleZ", SWAY_HEAD_AMPLITUDE * wave),
        },
        progress,
      };
    }
  }
}
