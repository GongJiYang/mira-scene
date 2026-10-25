import { describe, expect, it } from "vitest";
import { SESSION_TOKEN_TTL_MS, createTokenStore } from "../src/tokens";

describe("握手令牌", () => {
  it("发放的令牌可校验，且 30 分钟过期", () => {
    let now = 1_000_000;
    const store = createTokenStore({ now: () => now, generate: () => "token-1" });
    const issued = store.issue();
    expect(issued).toEqual({ token: "token-1", expiresAt: now + SESSION_TOKEN_TTL_MS });
    expect(store.validate("token-1")).toBe(true);

    now += SESSION_TOKEN_TTL_MS - 1;
    expect(store.validate("token-1")).toBe(true);

    now += 1;
    expect(store.validate("token-1")).toBe(false);
  });

  it("缺失 / 未知令牌一律拒绝", () => {
    const store = createTokenStore({ generate: () => "token-1" });
    store.issue();
    expect(store.validate(undefined)).toBe(false);
    expect(store.validate(null)).toBe(false);
    expect(store.validate("")).toBe(false);
    expect(store.validate("nope")).toBe(false);
  });

  it("每次发放不同令牌，且过期项在下次发放时清理", () => {
    let now = 0;
    let counter = 0;
    const store = createTokenStore({
      now: () => now,
      generate: () => `token-${(counter += 1)}`,
    });
    const first = store.issue();
    const second = store.issue();
    expect(first.token).not.toBe(second.token);

    now += SESSION_TOKEN_TTL_MS;
    store.issue();
    expect(store.validate(first.token)).toBe(false);
    expect(store.validate(second.token)).toBe(false);
  });
});
