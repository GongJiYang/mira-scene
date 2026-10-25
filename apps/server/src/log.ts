export type LogRecord = {
  ts: number;
  sessionId?: string;
  turnId?: number;
  event: string;
  ms?: number;
  detail?: unknown;
};

export type Logger = (record: LogRecord) => void;

/** 每个事件输出一行 JSON；`write` 可注入，便于测试捕获。 */
export function createLogger(write: (line: string) => void): Logger {
  return (record) => {
    write(JSON.stringify(record));
  };
}

export const consoleLogger: Logger = createLogger((line) => {
  console.log(line);
});

export const silentLogger: Logger = () => {};
