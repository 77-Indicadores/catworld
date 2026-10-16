import { describe, expect, it } from "vitest";
import { pickQueryStorage } from "./route-storage";

const AZ = "azure";
const PG = "pg-default";
const ds = (schemaName: string, storageServerId: string | null) => ({ id: schemaName, projectId: "tmk", schemaName, storageServerId });

// Caso real do projeto TMK: FTP no Azure SQL, GERAL/IFRACTAL no Postgres (padrao)
const ftp = ds("d_tmk_construtora_ftp", AZ);
const geral = ds("d_tmk_construtora_geral", PG);
const ifractal = ds("d_tmk_construtora_ifractal", null); // null = servidor padrao
const projeto = [ftp, geral, ifractal];
const pick = (sql: string, scoped = projeto, accessible = projeto) => pickQueryStorage({ sql, scoped, accessible, defaultId: PG });

describe("pickQueryStorage (servidor pelos schemas citados)", () => {
  it("schema do Postgres num projeto que comeca por um dataset do Azure: vai ao Postgres", () => {
    const r = pick("SELECT * FROM d_tmk_construtora_geral.fornecedores_contato");
    expect(r.storageServerId).toBe(PG);
    expect(r.schemas.sort()).toEqual(["d_tmk_construtora_geral", "d_tmk_construtora_ifractal"]);
  });

  it("schema do Azure: vai ao Azure, so com os schemas de la", () => {
    expect(pick('SELECT * FROM "d_tmk_construtora_ftp"."custos_2_10"')).toEqual({ storageServerId: AZ, schemas: ["d_tmk_construtora_ftp"] });
  });

  it("dataset com storageServerId null conta como o padrao (junta com quem esta explicitamente no padrao)", () => {
    const r = pick("SELECT * FROM d_tmk_construtora_geral.a g JOIN d_tmk_construtora_ifractal.b i ON g.id = i.id");
    expect(r.storageServerId).toBe(PG);
  });

  it("schemas em servidores diferentes: 400 MIXED_STORAGE com os grupos", () => {
    expect(() => pick("SELECT * FROM d_tmk_construtora_geral.a JOIN d_tmk_construtora_ftp.b ON 1=1"))
      .toThrow(expect.objectContaining({ status: 400, code: "MIXED_STORAGE" }));
  });

  it("sem escopo (SDK sem dataset/projeto): casa pelos datasets que o ator le", () => {
    expect(pick("SELECT * FROM d_tmk_construtora_ftp.t", [], projeto).storageServerId).toBe(AZ);
  });

  it("caixa diferente no SQL ainda casa", () => {
    expect(pick("SELECT * FROM D_TMK_CONSTRUTORA_FTP.t").storageServerId).toBe(AZ);
  });

  it("sem schema conhecido: comportamento anterior (1o dataset do escopo / padrao)", () => {
    expect(pick("SELECT * FROM t")).toEqual({ storageServerId: AZ, schemas: projeto.map((d) => d.schemaName) });
    expect(pick("SELECT * FROM information_schema.tables", [], projeto)).toEqual({ storageServerId: null, schemas: [] });
  });
});
