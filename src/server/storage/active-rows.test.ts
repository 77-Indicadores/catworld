import { describe, expect, it, vi } from "vitest";
import { activeRowsPredicate, hasDeletedAtColumn, joinWhere } from "./active-rows";
import type { StorageConnection } from "./connection";

function fakeConn(names: string[]) {
  const listColumns = vi.fn(async () => names.map((name) => ({ name, sqlType: "NVARCHAR(MAX)", nullable: true })));
  const conn = { listColumns, q: (s: string) => `"${s}"` } as unknown as StorageConnection;
  return { conn, listColumns };
}

describe("linhas ativas (cw_deleted_at)", () => {
  it("devolve o predicado quando a tabela tem cw_deleted_at", async () => {
    const { conn } = fakeConn(["a", "cw_synced_at", "cw_deleted_at"]);
    expect(await activeRowsPredicate(conn, "s", "t")).toBe('"cw_deleted_at" IS NULL');
  });

  it("devolve null em tabela antiga, sem a coluna", async () => {
    const { conn } = fakeConn(["a", "b"]);
    expect(await activeRowsPredicate(conn, "s", "t")).toBeNull();
  });

  it("cacheia a checagem por conexao e tabela", async () => {
    const { conn, listColumns } = fakeConn(["cw_deleted_at"]);
    await hasDeletedAtColumn(conn, "s", "t");
    await hasDeletedAtColumn(conn, "s", "t");
    await hasDeletedAtColumn(conn, "s", "outra");
    expect(listColumns).toHaveBeenCalledTimes(2);
  });

  it("joinWhere junta com AND e parentesa, preservando precedencia do $filter", () => {
    expect(joinWhere("a = 1 OR b = 2", '"cw_deleted_at" IS NULL')).toBe(' WHERE (a = 1 OR b = 2) AND ("cw_deleted_at" IS NULL)');
    expect(joinWhere(undefined, null, "  ")).toBe("");
    expect(joinWhere("x", null)).toBe(" WHERE (x)");
  });
});
