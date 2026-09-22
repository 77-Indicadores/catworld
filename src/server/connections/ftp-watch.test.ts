import { describe, expect, it } from "vitest";
import { downloadRemoteFile, remoteFileSignature, statRemoteFile } from "./ftp-watch";
import { mkdtempSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("remoteFileSignature", () => {
  it("muda quando tamanho ou mtime mudam; estável quando nada muda", () => {
    const a = remoteFileSignature({ size: 100, mtime: new Date("2026-01-01T00:00:00Z") });
    const b = remoteFileSignature({ size: 100, mtime: new Date("2026-01-01T00:00:00Z") });
    const c = remoteFileSignature({ size: 101, mtime: new Date("2026-01-01T00:00:00Z") });
    const d = remoteFileSignature({ size: 100, mtime: new Date("2026-01-02T00:00:00Z") });
    const e = remoteFileSignature({ size: 100, mtime: null });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).not.toBe(d);
    expect(a).not.toBe(e);
  });
});

/**
 * Contra o FTP real do TMK (só leitura: LIST e um download pequeno de um .txt de teste que já existe na pasta —
 * nunca o ZIP de 1,7 GB). Gated por env vars que o dono define localmente; nunca commitadas.
 * CW_TEST_FTP_HOST, CW_TEST_FTP_PORT, CW_TEST_FTP_USER, CW_TEST_FTP_PASSWORD.
 */
const creds = process.env.CW_TEST_FTP_HOST
  ? {
      host: process.env.CW_TEST_FTP_HOST,
      port: process.env.CW_TEST_FTP_PORT ? Number(process.env.CW_TEST_FTP_PORT) : 21,
      user: process.env.CW_TEST_FTP_USER!,
      password: process.env.CW_TEST_FTP_PASSWORD!,
    }
  : null;
const d = creds ? describe : describe.skip;

d("ftp-watch (FTP real)", () => {
  it("statRemoteFile acha o zip do PLV sem baixar nada", async () => {
    const stat = await statRemoteFile(creds!, "/PLV", "*.zip");
    expect(stat).not.toBeNull();
    expect(stat!.size).toBeGreaterThan(1_000_000_000); // > 1GB — confirma que achou o backup, não o .txt de teste
    expect(stat!.name.toLowerCase()).toMatch(/\.zip$/);
  });

  it("statRemoteFile devolve null quando nada casa o padrão", async () => {
    const stat = await statRemoteFile(creds!, "/PLV", "*.nao-existe-extensao-nenhuma");
    expect(stat).toBeNull();
  });

  it("downloadRemoteFile baixa um arquivo pequeno de verdade e nunca deixa .part para trás", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ftp-watch-"));
    const dest = join(dir, "teste.txt");
    await downloadRemoteFile(creds!, "/PLV/Cobian Reflector upload test.txt", dest);
    expect(existsSync(dest)).toBe(true);
    expect(existsSync(`${dest}.part`)).toBe(false);
    expect(statSync(dest).size).toBeGreaterThan(0);
  });

  it("downloadRemoteFile falha alto (e limpa o .part) quando o caminho remoto não existe", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ftp-watch-"));
    const dest = join(dir, "nao-vai-existir.bin");
    await expect(downloadRemoteFile(creds!, "/PLV/isso-nao-existe.zip", dest)).rejects.toThrow();
    expect(existsSync(dest)).toBe(false);
    expect(existsSync(`${dest}.part`)).toBe(false);
  });
});
