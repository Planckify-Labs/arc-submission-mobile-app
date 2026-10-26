/**
 * In-place sign-in for the agent chat: the store that hands a request to
 * the mounted host, and `request_authentication` using it instead of
 * pushing `/auth` and polling.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const push = vi.fn();
const checkPointsAuth = vi.fn();

vi.mock("expo-router", () => ({
  router: { push: (...a: unknown[]) => push(...a) },
}));
vi.mock("@/services/agent-executors/chainRouter", () => ({
  resolveChainClients: vi.fn(),
}));
vi.mock("@/services/agent-executors/pointsAuth", () => ({
  checkPointsAuth: (...a: unknown[]) => checkPointsAuth(...a),
}));

import { requestAuthentication } from "@/services/agent-executors/wallet/simulate";
import { inlineSignIn } from "./inlineSignIn";

const context = { wallet: { address: "0xabc" } } as never;

describe("inlineSignIn", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    inlineSignIn.__resetForTests();
  });

  it("is unavailable without a host, and says so instead of hanging", async () => {
    expect(inlineSignIn.isAvailable()).toBe(false);
    await expect(inlineSignIn.request()).resolves.toBe("failed");
  });

  it("shares one flow between concurrent requests", async () => {
    let finish: (r: "signed_in") => void = () => {};
    const handler = vi.fn(
      () => new Promise<"signed_in">((resolve) => (finish = resolve)),
    );
    inlineSignIn.register(handler);
    const a = inlineSignIn.request();
    const b = inlineSignIn.request();
    finish("signed_in");
    await expect(Promise.all([a, b])).resolves.toEqual([
      "signed_in",
      "signed_in",
    ]);
    expect(handler).toHaveBeenCalledOnce();
  });

  it("only the current host can unregister itself", () => {
    const offOld = inlineSignIn.register(async () => "cancelled");
    inlineSignIn.register(async () => "signed_in");
    offOld();
    expect(inlineSignIn.isAvailable()).toBe(true);
  });
});

describe("request_authentication inside the agent chat", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    inlineSignIn.__resetForTests();
  });

  it("signs in over the chat without opening /auth", async () => {
    checkPointsAuth.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    inlineSignIn.register(async () => "signed_in");
    const r = await requestAuthentication({}, context);
    expect(r).toEqual({ status: "success", data: { success: true } });
    expect(push).not.toHaveBeenCalled();
  });

  it("reports a closed sheet as a cancel at once, with no polling", async () => {
    checkPointsAuth.mockResolvedValue(false);
    inlineSignIn.register(async () => "cancelled");
    const r = await requestAuthentication({}, context);
    expect(r).toEqual({
      status: "success",
      data: { success: false, error: "user_cancelled" },
    });
    expect(push).not.toHaveBeenCalled();
  });
});
