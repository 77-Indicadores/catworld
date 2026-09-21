import { describe, expect, it, vi } from "vitest";
import { retakeLeadership } from "./leadership";

const noSleep = { sleep: async () => undefined, baseDelayMs: 0 };

describe("retakeLeadership", () => {
  it("consegue o lock de novo na primeira tentativa", async () => {
    expect(await retakeLeadership(async () => "lock", noSleep)).toBe("lock");
  });
  it("erro de conexão transitório: tenta de novo até conseguir", async () => {
    const acquire = vi.fn().mockRejectedValueOnce(new Error("ECONNREFUSED")).mockRejectedValueOnce(new Error("timeout")).mockResolvedValue("lock");
    expect(await retakeLeadership(acquire, noSleep)).toBe("lock");
    expect(acquire).toHaveBeenCalledTimes(3);
  });
  it("outro supervisor já tem o lock (null): não insiste e devolve null", async () => {
    const acquire = vi.fn().mockResolvedValue(null);
    expect(await retakeLeadership(acquire, noSleep)).toBeNull();
    expect(acquire).toHaveBeenCalledTimes(1);
  });
  it("banco fora do ar por todas as tentativas: desiste (null) depois do limite", async () => {
    const acquire = vi.fn().mockRejectedValue(new Error("down"));
    expect(await retakeLeadership(acquire, { ...noSleep, attempts: 4 })).toBeNull();
    expect(acquire).toHaveBeenCalledTimes(4);
  });
  it("espera cresce entre as tentativas (não martela o banco)", async () => {
    const waits: number[] = [];
    const acquire = vi.fn().mockRejectedValue(new Error("down"));
    await retakeLeadership(acquire, { attempts: 4, baseDelayMs: 100, sleep: async (ms) => { waits.push(ms); } });
    expect(waits).toEqual([100, 200, 300]);
  });
});
