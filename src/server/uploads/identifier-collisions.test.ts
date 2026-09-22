// @vitest-environment node
/** TIP-12/16 pelo parser real: cabeçalhos que colidem ou colidem com colunas internas. */
import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { previewFile } from "./parser";

const dir = mkdtempSync(join(tmpdir(), "cw-ident-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let seq = 0;
const names = async (header: string) => {
  const p = join(dir, `f${seq++}.csv`);
  writeFileSync(p, header + "\n" + header.split(",").map(() => "x").join(",") + "\n");
  return (await previewFile(p)).columns.map((c) => c.sqlName);
};

describe("colisão de cabeçalhos", () => {
  it("a, a, a_2, a: todos distintos (antes: a_2 repetido)", async () => {
    const n = await names("a,a,a_2,a");
    expect(new Set(n).size).toBe(4);
    expect(n[0]).toBe("a");
  });
  it("Nome, nome, NOME e nome_2", async () => {
    expect(new Set(await names("Nome,nome,NOME,nome_2")).size).toBe(4);
  });
  it("cabeçalhos que só diferem por acento/pontuação colidem e são desambiguados", async () => {
    expect(new Set(await names("Valor R$,Valor R,valor")).size).toBe(3);
  });
  it("cw_deleted_at e cw_synced_at do usuário não colidem com as internas", async () => {
    const n = await names("id,cw_deleted_at,cw_synced_at,_cw_rh");
    expect(n).toEqual(["id", "cw_deleted_at_col", "cw_synced_at_col", "cw_rh_col"]);
  });
  it("nome de 200 caracteres: cabe em 128 e continua único", async () => {
    const n = await names(`${"z".repeat(200)}a,${"z".repeat(200)}b`);
    expect(n.every((x) => x.length <= 128)).toBe(true);
    expect(new Set(n).size).toBe(2);
  });
});
