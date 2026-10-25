import { randomBytes } from "node:crypto";

/** 握手令牌有效期（D8 复核 · Q12）：30 分钟。 */
export const SESSION_TOKEN_TTL_MS = 30 * 60 * 1000;

export type SessionToken = { token: string; expiresAt: number };

export type TokenStore = {
  /** 发放新令牌，顺带清理过期项。 */
  issue(): SessionToken;
  /** 缺失 / 未知 / 过期都返回 false。 */
  validate(token: string | null | undefined): boolean;
};

export type TokenStoreOptions = {
  now?: () => number;
  ttlMs?: number;
  generate?: () => string;
};

/** 内存令牌表：进程重启即失效，不落盘。 */
export function createTokenStore(options: TokenStoreOptions = {}): TokenStore {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? SESSION_TOKEN_TTL_MS;
  const generate = options.generate ?? (() => randomBytes(24).toString("base64url"));
  const tokens = new Map<string, number>();

  function prune(at: number): void {
    for (const [token, expiresAt] of tokens) {
      if (expiresAt <= at) tokens.delete(token);
    }
  }

  return {
    issue() {
      const at = now();
      prune(at);
      const token = generate();
      const expiresAt = at + ttlMs;
      tokens.set(token, expiresAt);
      return { token, expiresAt };
    },
    validate(token) {
      if (!token) return false;
      const at = now();
      const expiresAt = tokens.get(token);
      if (expiresAt === undefined) return false;
      if (expiresAt <= at) {
        tokens.delete(token);
        return false;
      }
      return true;
    },
  };
}
