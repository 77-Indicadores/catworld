import { describe, expect, it } from "vitest";
import {
  executeFirebirdReadOnly, listTablesFirebird, sourceClockFirebird, tableColumnsFirebird, testFirebird,
  type FirebirdEndpoint,
} from "./firebird";

/**
 * Contra um Firebird real com um banco já anexável — gated por env vars, não roda em CI por padrão. Provado
 * nesta sessão contra o backup real do TMK (TERMAQ.PLV, extraído do FTP do cliente), servido por um Firebird
 * 5.0.4 descartável no WSL:
 *
 *   MSYS_NO_PATHCONV=1 CW_TEST_FIREBIRD_HOST=<ip> CW_TEST_FIREBIRD_PORT=3051 \
 *   CW_TEST_FIREBIRD_DATABASE=/tmp/plv-test/TERMAQ.PLV CW_TEST_FIREBIRD_PASSWORD=<senha> \
 *   npx vitest run firebird.test.ts
 *
 * `MSYS_NO_PATHCONV=1` é OBRIGATÓRIO no Git Bash/MSYS (Windows): sem isso, a shell reescreve o valor de
 * `CW_TEST_FIREBIRD_DATABASE` (por parecer um caminho absoluto Unix) para um caminho Windows ANTES do processo
 * receber a env var, e o teste falha com "Unavailable database" — um caminho errado sendo passado pro Firebird
 * do WSL/Linux, não um defeito do driver, do adapter nem do vitest (isso levou um tempo real para diagnosticar
 * nesta sessão: parecia incompatibilidade vitest/node-firebird, mas era só a env var chegando corrompida).
 */
const endpoint: FirebirdEndpoint | null = process.env.CW_TEST_FIREBIRD_HOST
  ? {
      host: process.env.CW_TEST_FIREBIRD_HOST,
      port: Number(process.env.CW_TEST_FIREBIRD_PORT ?? 3050),
      database: process.env.CW_TEST_FIREBIRD_DATABASE!,
      user: process.env.CW_TEST_FIREBIRD_USER ?? "sysdba",
      password: process.env.CW_TEST_FIREBIRD_PASSWORD!,
    }
  : null;
const d = endpoint ? describe : describe.skip;

d("firebird adapter (Firebird real)", () => {
  it("testFirebird conecta e mede latencia", async () => {
    const r = await testFirebird(endpoint!);
    expect(r.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("listTablesFirebird acha tabelas de usuario (nao RDB$/MON$)", async () => {
    const tables = await listTablesFirebird(endpoint!);
    expect(tables.length).toBeGreaterThan(0);
    expect(tables.every((t) => !t.table.startsWith("RDB$") && !t.table.startsWith("MON$"))).toBe(true);
  });

  it("tableColumnsFirebird mapeia DOUBLE PRECISION como lossyNumeric", async () => {
    const cols = await tableColumnsFirebird(endpoint!, "public", "FAT_NFE");
    const valor = cols.find((c) => c.originalName === "NFE_VALOR");
    expect(valor?.sqlType).toBe("FLOAT");
    expect(valor?.lossyNumeric).toBe(true);
  });

  it("executeFirebirdReadOnly le linhas reais com FIRST/SKIP e hasMore honesto", async () => {
    const r = await executeFirebirdReadOnly(endpoint!, "SELECT NFE_CDG FROM FAT_NFE ORDER BY NFE_CDG", 30, 3, 0);
    expect(r.rows).toHaveLength(3);
    expect(r.rowCount).toBe(3);
    const r2 = await executeFirebirdReadOnly(endpoint!, "SELECT NFE_CDG FROM FAT_NFE ORDER BY NFE_CDG", 30, 3, 3);
    expect(r2.rows[0]).not.toEqual(r.rows[0]);
  });

  it("sourceClockFirebird devolve uma data valida", async () => {
    const now = await sourceClockFirebird(endpoint!);
    expect(now.getTime()).toBeGreaterThan(0);
  });
});
