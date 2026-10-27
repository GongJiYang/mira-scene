/**
 * S6h §2：`?obs=1` 观测页。独立路由，不连 WebSocket，每 2 秒拉一次 /obs/summary。
 *
 * 四块：最近 20 轮瀑布条 / 阶段耗时 p50·p95·max / 错误与兜底计数 / 模型调用表。
 * 空数据显示占位；接口失败显示「观测接口不可用」且继续重试。
 */
import { useEffect, useState } from "react";
import { OBS_TEXT } from "./obsText";
import "./obs.css";

type TurnTimeline = {
  turnId: number;
  sessionId?: string;
  startedAt: number;
  sttMs?: number;
  llmFirstBeatMs?: number;
  ttsFirstAudioMs?: number;
  playbackMs?: number;
  endMs?: number;
  endReason?: string;
  aborted: boolean;
  failed: boolean;
};

type StageStats = { stage: string; count: number; p50: number; p95: number; max: number };
type ErrorCount = { event: string; code?: string; category?: string; count: number; count5m: number };
type ModelCallStats = { port: string; count: number; failed: number; avgMs?: number };

type ObsSummary = {
  now: number;
  bufferSize: number;
  turns: TurnTimeline[];
  stages: StageStats[];
  errors: ErrorCount[];
  modelCalls: ModelCallStats[];
};

const POLL_MS = 2000;

/** 走 vite 代理（/obs → 服务端），同源部署时直接命中。 */
async function fetchSummary(): Promise<ObsSummary> {
  const response = await fetch("/obs/summary", { cache: "no-store" });
  if (!response.ok) throw new Error(`obs ${response.status}`);
  return (await response.json()) as ObsSummary;
}

/** 一轮的瀑布条：相对本轮最大值的百分比定位。 */
function TurnBar({ turn }: { turn: TurnTimeline }) {
  const points: { key: string; ms: number | undefined; cls: string }[] = [
    { key: "stt", ms: turn.sttMs, cls: "obs-seg-stt" },
    { key: "llm", ms: turn.llmFirstBeatMs, cls: "obs-seg-llm" },
    { key: "tts", ms: turn.ttsFirstAudioMs, cls: "obs-seg-tts" },
    { key: "play", ms: turn.playbackMs, cls: "obs-seg-play" },
    { key: "end", ms: turn.endMs, cls: "obs-seg-end" },
  ];
  const max = Math.max(1, ...points.map((p) => p.ms ?? 0));
  let prev = 0;
  const segs = [];
  for (const p of points) {
    if (p.ms === undefined) continue;
    const startPct = (prev / max) * 100;
    const widthPct = Math.max(1.5, ((p.ms - prev) / max) * 100);
    segs.push(
      <span
        key={p.key}
        className={`obs-seg ${p.cls}`}
        style={{ left: `${startPct}%`, width: `${Math.min(100 - startPct, widthPct)}%` }}
      />,
    );
    prev = Math.max(prev, p.ms);
  }
  const flag = turn.failed ? OBS_TEXT.turnFailed : turn.aborted ? OBS_TEXT.turnAborted : "";
  return (
    <div className="obs-turn" data-testid="obs-turn" data-aborted={turn.aborted ? "1" : "0"} data-failed={turn.failed ? "1" : "0"}>
      <span className="obs-turn-id">{OBS_TEXT.turnLabel(turn.turnId)}</span>
      <span className="obs-turn-bar">{segs}</span>
      {flag !== "" && <span className="obs-turn-flag">{flag}</span>}
    </div>
  );
}

export function ObsApp() {
  const [summary, setSummary] = useState<ObsSummary | null>(null);
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let timer = 0;
    const tick = async (): Promise<void> => {
      try {
        const data = await fetchSummary();
        if (cancelled) return;
        setSummary(data);
        setUnavailable(false);
      } catch {
        if (cancelled) return;
        setUnavailable(true);
      } finally {
        if (!cancelled) timer = window.setTimeout(() => void tick(), POLL_MS);
      }
    };
    void tick();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, []);

  const empty = summary !== null && summary.turns.length === 0;

  return (
    <main className="obs-root" data-testid="obs-app">
      <header className="obs-header">
        <h1 className="obs-title">{OBS_TEXT.title}</h1>
        <span className="obs-refresh">{OBS_TEXT.refresh}</span>
      </header>

      {unavailable && (
        <p className="obs-error" data-testid="obs-unavailable">
          {OBS_TEXT.unavailable}
        </p>
      )}

      {empty ? (
        <p className="obs-empty" data-testid="obs-empty">
          {OBS_TEXT.empty}
        </p>
      ) : (
        <>
          <section className="obs-section" data-testid="obs-turns">
            <h2>{OBS_TEXT.sectionTurns}</h2>
            <div className="obs-turns">
              {(summary?.turns ?? []).map((turn) => (
                <TurnBar key={`${turn.sessionId ?? ""}:${turn.turnId}:${turn.startedAt}`} turn={turn} />
              ))}
            </div>
            <div className="obs-legend">
              <span className="obs-legend-stt">{OBS_TEXT.legendStt}</span>
              <span className="obs-legend-llm">{OBS_TEXT.legendLlm}</span>
              <span className="obs-legend-tts">{OBS_TEXT.legendTts}</span>
              <span className="obs-legend-play">{OBS_TEXT.legendPlayback}</span>
              <span className="obs-legend-end">{OBS_TEXT.legendEnd}</span>
            </div>
          </section>

          <section className="obs-section" data-testid="obs-stages">
            <h2>{OBS_TEXT.sectionStages}</h2>
            <table className="obs-table">
              <thead>
                <tr>
                  <th>{OBS_TEXT.colStage}</th>
                  <th>{OBS_TEXT.colP50}</th>
                  <th>{OBS_TEXT.colP95}</th>
                  <th>{OBS_TEXT.colMax}</th>
                  <th>{OBS_TEXT.colCount}</th>
                </tr>
              </thead>
              <tbody>
                {(summary?.stages ?? []).map((s) => (
                  <tr key={s.stage} data-stage={s.stage}>
                    <td>{s.stage}</td>
                    <td>{Math.round(s.p50)}</td>
                    <td>{Math.round(s.p95)}</td>
                    <td>{Math.round(s.max)}</td>
                    <td>{s.count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <section className="obs-section" data-testid="obs-errors">
            <h2>{OBS_TEXT.sectionErrors}</h2>
            <table className="obs-table">
              <thead>
                <tr>
                  <th>{OBS_TEXT.colEvent}</th>
                  <th>{OBS_TEXT.colCode}</th>
                  <th>{OBS_TEXT.colAll}</th>
                  <th>{OBS_TEXT.col5m}</th>
                </tr>
              </thead>
              <tbody>
                {(summary?.errors ?? []).map((e) => (
                  <tr key={`${e.event}|${e.code ?? ""}|${e.category ?? ""}`}>
                    <td>{e.event}</td>
                    <td>{e.code ?? e.category ?? ""}</td>
                    <td>{e.count}</td>
                    <td>{e.count5m}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <section className="obs-section" data-testid="obs-models">
            <h2>{OBS_TEXT.sectionModels}</h2>
            <table className="obs-table">
              <thead>
                <tr>
                  <th>{OBS_TEXT.colPort}</th>
                  <th>{OBS_TEXT.colCalls}</th>
                  <th>{OBS_TEXT.colFailed}</th>
                  <th>{OBS_TEXT.colAvgMs}</th>
                </tr>
              </thead>
              <tbody>
                {(summary?.modelCalls ?? []).map((m) => (
                  <tr key={m.port}>
                    <td>{m.port}</td>
                    <td>{m.count}</td>
                    <td>{m.failed}</td>
                    <td>{m.avgMs ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </>
      )}
    </main>
  );
}
