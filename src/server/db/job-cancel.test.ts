import { describe, expect, it } from "vitest";
import { JobCancelledError, assertNotCancelled, runWithCancelToken, watchJobStatus } from "./job-cancel";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("cancelamento cooperativo", () => {
  it("fora de um job não faz nada", () => {
    expect(() => assertNotCancelled()).not.toThrow();
  });
  it("token cancelado: o ponto de checagem lança e o trabalho para antes de publicar", async () => {
    const token = { cancelled: false };
    const steps: string[] = [];
    await expect(runWithCancelToken(token, async () => {
      steps.push("carregou");
      token.cancelled = true;                       // o worker viu o job cancelado
      await sleep(5);                               // o contexto atravessa awaits
      assertNotCancelled();
      steps.push("publicou");                        // não pode chegar aqui
    })).rejects.toBeInstanceOf(JobCancelledError);
    expect(steps).toEqual(["carregou"]);
  });
  it("tokens de jobs concorrentes são independentes", async () => {
    const a = { cancelled: true }, b = { cancelled: false };
    const [ra, rb] = await Promise.allSettled([
      runWithCancelToken(a, async () => { await sleep(10); assertNotCancelled(); }),
      runWithCancelToken(b, async () => { await sleep(10); assertNotCancelled(); return "ok"; }),
    ]);
    expect(ra.status).toBe("rejected");
    expect(rb).toEqual({ status: "fulfilled", value: "ok" });
  });
  it("watchJobStatus marca o token quando o job deixa de estar RUNNING; erro de banco não cancela", async () => {
    const token = { cancelled: false };
    let status: string | null = "RUNNING"; let fail = false;
    const stop = watchJobStatus(token, async () => { if (fail) throw new Error("db"); return status; }, 10);
    await sleep(40); expect(token.cancelled).toBe(false);
    fail = true; await sleep(40); expect(token.cancelled).toBe(false);   // falha transitória: continua
    fail = false; status = "FAILED"; await sleep(40);
    stop();
    expect(token.cancelled).toBe(true);
    const t2 = { cancelled: false };
    const stop2 = watchJobStatus(t2, async () => null, 10);               // job apagado (null) também cancela
    await sleep(40); stop2();
    expect(t2.cancelled).toBe(true);
  });
});
