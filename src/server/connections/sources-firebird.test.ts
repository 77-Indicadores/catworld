import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  datasetSource: { findUnique: vi.fn(), findMany: vi.fn(), updateMany: vi.fn(), update: vi.fn() },
  datasetColumn: { deleteMany: vi.fn(async () => undefined), createMany: vi.fn(async () => undefined) },
  datasetTable: { update: vi.fn(async () => undefined) },
  datasetVersion: { create: vi.fn(async () => undefined) },
  connection: { findMany: vi.fn() },
  $queryRawUnsafe: vi.fn(),
  $transaction: vi.fn(async (ops: unknown[]) => Promise.all(ops)),
}));
const storage = vi.hoisted(() => ({
  createSchemaIfNotExists: vi.fn(async () => undefined),
  tableExists: vi.fn(async () => false),
  dropTableIfExists: vi.fn(async () => undefined),
  createTable: vi.fn(async () => undefined),
  bulkInsert: vi.fn(async () => undefined),
  countRows: vi.fn(async () => 0n),
  atomicSwap: vi.fn(async () => ({ marked: 0 })),
  q: (s: string) => `"${s}"`,
}));
const firebirdMaterializeMock = vi.hoisted(() => ({
  ensureMaterialized: vi.fn(),
  renewMaterialization: vi.fn(async () => undefined),
  ftpCredsFromConnection: vi.fn(() => ({ host: "ftp.example.com", port: 21, user: "u", password: "p" })),
  DEFAULT_FIREBIRD_POLL_MINUTES: 60,
}));
const ftpWatchMock = vi.hoisted(() => ({
  statRemoteFile: vi.fn(),
  remoteFileSignature: vi.fn((stat: { size: number; mtime: Date | null }) => `${stat.size}:${stat.mtime ? stat.mtime.toISOString() : ""}`),
}));
const firebirdMock = vi.hoisted(() => ({
  tableColumnsFirebird: vi.fn(async () => [{ originalName: "id", sqlName: "id", sqlType: "BIGINT", nullable: false }]),
  queryColumnsFirebird: vi.fn(async () => [{ originalName: "id", sqlName: "id", sqlType: "BIGINT", nullable: false }]),
  quotedFirebirdTable: vi.fn((table: string) => `"${table}"`),
  sourceClockFirebird: vi.fn(async () => new Date("2026-01-02T00:00:00Z")),
  streamFirebirdRows: vi.fn(async function* () { yield [{ id: 1 }]; }),
}));

vi.mock("@/server/db", () => ({ prisma: prismaMock }));
vi.mock("@/server/db/advisory-lock", () => ({ withAdvisoryLock: (_k: string, fn: () => unknown) => fn() }));
vi.mock("@/server/azure/sql", () => ({ sqlPool: vi.fn(), ensureSchema: vi.fn() }));
vi.mock("@/server/storage/connection", () => ({ getStorageConnection: vi.fn(async () => storage) }));
vi.mock("./postgres", () => ({
  queryColumns: vi.fn(), quotedPgTable: vi.fn(), streamPostgresRows: vi.fn(), sourceClockPg: vi.fn(),
  tableColumns: vi.fn(),
}));
vi.mock("./mssql", () => ({ sourceClockMssql: vi.fn(), queryColumnsMssql: vi.fn(), quotedMssqlTable: vi.fn(), streamMssqlRows: vi.fn(), tableColumnsMssql: vi.fn() }));
vi.mock("./firebird", () => firebirdMock);
vi.mock("./firebird-materialize", () => firebirdMaterializeMock);
vi.mock("./ftp-watch", () => ftpWatchMock);

import { enqueueDueFirebirdFtpRefreshes, firebirdEndpointFor, parseFirebirdFtpConfig, refreshDatasetSource } from "./sources";

const validEndpoint = { host: "127.0.0.1", port: 3050, database: "/var/lib/catworld/firebird-restore/c1/x.fdb", user: "sysdba", password: "secret" };

describe("parseFirebirdFtpConfig", () => {
  it("aceita o formato minimo documentado (so ftp, sem firebird opcional)", () => {
    const cfg = parseFirebirdFtpConfig(JSON.stringify({ ftp: { host: "194.238.31.66", port: 2521, remotePath: "/PLV", filePattern: "*.zip" } }));
    expect(cfg.ftp.remotePath).toBe("/PLV");
    expect(cfg.firebird).toBeUndefined();
  });

  it("aceita o bloco firebird opcional (innerFilePattern/charset)", () => {
    const cfg = parseFirebirdFtpConfig(JSON.stringify({
      ftp: { host: "h", remotePath: "/PLV", filePattern: "*.zip" },
      firebird: { innerFilePattern: "*.PLV", charset: "WIN1252" },
    }));
    expect(cfg.firebird?.charset).toBe("WIN1252");
  });

  it("rejeita metadataJson ausente/vazio com 400 claro", () => {
    expect(() => parseFirebirdFtpConfig(null)).toThrow(/metadataJson/);
    expect(() => parseFirebirdFtpConfig("")).toThrow();
    expect(() => parseFirebirdFtpConfig("   ")).toThrow();
  });

  it("rejeita JSON malformado com 400 claro (nao deixa estourar la no fundo do materializador)", () => {
    expect(() => parseFirebirdFtpConfig("{ nao e json")).toThrow(/nao e um JSON valido/);
  });

  it("rejeita campos obrigatorios faltando (ftp.remotePath, ftp.filePattern)", () => {
    expect(() => parseFirebirdFtpConfig(JSON.stringify({ ftp: { host: "h" } }))).toThrow(/metadataJson.*invalido/);
    expect(() => parseFirebirdFtpConfig(JSON.stringify({ ftp: { host: "h", remotePath: "/x" } }))).toThrow(/filePattern/);
  });

  it("rejeita o campo ftp inteiro faltando", () => {
    expect(() => parseFirebirdFtpConfig(JSON.stringify({}))).toThrow(/metadataJson.*invalido/);
  });
});

describe("firebirdEndpointFor", () => {
  beforeEach(() => vi.clearAllMocks());

  const connection = {
    id: "c1", provider: "firebird-ftp", server: "194.238.31.66", port: 2521, username: "ftpuser",
    encryptedCredentials: "irrelevant-aqui-pois-ftpCredsFromConnection-esta-mockado",
    metadataJson: JSON.stringify({ ftp: { host: "194.238.31.66", port: 2521, remotePath: "/PLV", filePattern: "*.zip" } }),
  };

  it("chama ensureMaterialized com creds+config e devolve o endpoint pronto", async () => {
    firebirdMaterializeMock.ensureMaterialized.mockResolvedValue({ endpoint: validEndpoint, expiresAt: new Date() });
    const endpoint = await firebirdEndpointFor(connection);
    expect(endpoint).toEqual(validEndpoint);
    expect(firebirdMaterializeMock.ensureMaterialized).toHaveBeenCalledTimes(1);
    expect(firebirdMaterializeMock.ensureMaterialized).toHaveBeenCalledWith(
      "c1",
      { host: "ftp.example.com", port: 21, user: "u", password: "p" },
      expect.objectContaining({ ftp: expect.objectContaining({ remotePath: "/PLV", filePattern: "*.zip" }) }),
    );
  });

  it("recusa (400) uma conexao com metadataJson invalido ANTES de chamar ensureMaterialized", async () => {
    await expect(firebirdEndpointFor({ ...connection, metadataJson: "{ nao e json" })).rejects.toThrow(/nao e um JSON valido/);
    expect(firebirdMaterializeMock.ensureMaterialized).not.toHaveBeenCalled();
  });

  it("recusa metadataJson ausente ANTES de chamar ensureMaterialized", async () => {
    await expect(firebirdEndpointFor({ ...connection, metadataJson: null })).rejects.toThrow(/exige metadataJson/);
    expect(firebirdMaterializeMock.ensureMaterialized).not.toHaveBeenCalled();
  });

  it("propaga a falha de ensureMaterialized (FTP fora do ar, disco cheio etc.) sem mascarar o erro", async () => {
    firebirdMaterializeMock.ensureMaterialized.mockRejectedValue(new Error("espaço insuficiente para materializar"));
    await expect(firebirdEndpointFor(connection)).rejects.toThrow("espaço insuficiente para materializar");
  });

  it("recusa uma conexao que nao e firebird-ftp (erro de programacao do chamador, nao input do usuario)", async () => {
    await expect(firebirdEndpointFor({ ...connection, provider: "postgres" })).rejects.toThrow(/firebird-ftp/);
    expect(firebirdMaterializeMock.ensureMaterialized).not.toHaveBeenCalled();
  });
});

describe("enqueueDueFirebirdFtpRefreshes: chegada de arquivo novo dispara as fontes atreladas, sem cron por tabela", () => {
  beforeEach(() => vi.clearAllMocks());

  function connectionRow(id: string) {
    return {
      id, provider: "firebird-ftp", server: "194.238.31.66", port: 2521, username: "ftpuser",
      encryptedCredentials: "x",
      metadataJson: JSON.stringify({ ftp: { host: "194.238.31.66", remotePath: "/PLV", filePattern: "*.zip" } }),
    };
  }

  it("nao dispara nada quando a assinatura remota nao mudou desde a ultima sincronizacao", async () => {
    const id = "watch-unchanged";
    prismaMock.connection.findMany.mockResolvedValue([connectionRow(id)]);
    ftpWatchMock.statRemoteFile.mockResolvedValue({ name: "x.zip", path: "/PLV/x.zip", size: 100, mtime: new Date("2026-01-01T00:00:00Z") });
    prismaMock.$queryRawUnsafe.mockResolvedValue([{ remote_signature: "100:2026-01-01T00:00:00.000Z" }]);

    await enqueueDueFirebirdFtpRefreshes();

    expect(ftpWatchMock.statRemoteFile).toHaveBeenCalledTimes(1);
    expect(prismaMock.datasetSource.findMany).not.toHaveBeenCalled();
  });

  it("dispara o refresh de todas as fontes ativas da conexao quando o arquivo remoto mudou", async () => {
    const id = "watch-changed";
    prismaMock.connection.findMany.mockResolvedValue([connectionRow(id)]);
    ftpWatchMock.statRemoteFile.mockResolvedValue({ name: "x.zip", path: "/PLV/x.zip", size: 200, mtime: new Date("2026-01-02T00:00:00Z") });
    prismaMock.$queryRawUnsafe.mockResolvedValue([{ remote_signature: "100:2026-01-01T00:00:00.000Z" }]); // assinatura antiga, diferente
    prismaMock.datasetSource.findMany.mockResolvedValue([{ id: "s1" }, { id: "s2" }]);

    await enqueueDueFirebirdFtpRefreshes();

    expect(prismaMock.datasetSource.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ connectionId: id, active: true, mode: "extract" }) }),
    );
  });

  it("primeira sincronizacao (sem materializacao previa) tambem dispara todas as fontes", async () => {
    const id = "watch-first-time";
    prismaMock.connection.findMany.mockResolvedValue([connectionRow(id)]);
    ftpWatchMock.statRemoteFile.mockResolvedValue({ name: "x.zip", path: "/PLV/x.zip", size: 200, mtime: new Date("2026-01-02T00:00:00Z") });
    prismaMock.$queryRawUnsafe.mockResolvedValue([]); // nenhuma materializacao registrada ainda
    prismaMock.datasetSource.findMany.mockResolvedValue([{ id: "s1" }]);

    await enqueueDueFirebirdFtpRefreshes();

    expect(prismaMock.datasetSource.findMany).toHaveBeenCalled();
  });

  it("arquivo ainda nao chegou (pasta vazia): nao e erro, so nao dispara nada", async () => {
    const id = "watch-empty-folder";
    prismaMock.connection.findMany.mockResolvedValue([connectionRow(id)]);
    ftpWatchMock.statRemoteFile.mockResolvedValue(null);

    await expect(enqueueDueFirebirdFtpRefreshes()).resolves.toBeUndefined();
    expect(prismaMock.datasetSource.findMany).not.toHaveBeenCalled();
  });

  it("respeita o intervalo minimo entre checagens: a segunda chamada rapida nao bate no FTP de novo", async () => {
    const id = "watch-throttle";
    prismaMock.connection.findMany.mockResolvedValue([connectionRow(id)]);
    ftpWatchMock.statRemoteFile.mockResolvedValue({ name: "x.zip", path: "/PLV/x.zip", size: 100, mtime: new Date("2026-01-01T00:00:00Z") });
    prismaMock.$queryRawUnsafe.mockResolvedValue([{ remote_signature: "100:2026-01-01T00:00:00.000Z" }]);

    await enqueueDueFirebirdFtpRefreshes();
    await enqueueDueFirebirdFtpRefreshes();

    expect(ftpWatchMock.statRemoteFile).toHaveBeenCalledTimes(1);
  });
});

describe("refreshDatasetSource (firebird-ftp): materializa no maximo uma vez por rodada", () => {
  beforeEach(() => vi.clearAllMocks());

  const sourceRow = {
    id: "11111111-1111-1111-1111-111111111111", active: true, mode: "extract", sourceKind: "table",
    sourceSchema: "public", sourceTable: "fat_nfe", deltaColumn: null, lastDeltaValue: null, keyColumn: null,
    refreshCron: null, reconciliationCron: null, sourceSql: null, sourceSqlReconciliation: null,
    connectionId: "c1",
    dataset: { storageServerId: null, schemaName: "ds" },
    connection: {
      id: "c1", provider: "firebird-ftp", server: "194.238.31.66", port: 2521, username: "ftpuser",
      encryptedCredentials: "x", metadataJson: JSON.stringify({ ftp: { host: "194.238.31.66", remotePath: "/PLV", filePattern: "*.zip" } }),
    },
    targetTable: { id: "tt", sqlName: "fat_nfe", columns: [] },
  };

  it("chama ensureMaterialized exatamente uma vez mesmo com varias leituras internas (colunas + relogio + streaming)", async () => {
    prismaMock.datasetSource.findUnique.mockResolvedValue(sourceRow);
    prismaMock.datasetSource.updateMany.mockResolvedValue({ count: 1 });
    firebirdMaterializeMock.ensureMaterialized.mockResolvedValue({ endpoint: validEndpoint, expiresAt: new Date() });

    const result = await refreshDatasetSource(sourceRow.id);

    expect(result.rowCount).toBe(0n);
    // tableColumnsFirebird (probe de colunas) + sourceClockFirebird (relogio, so quando ha delta — aqui nao ha,
    // entao nao roda) + streamFirebirdRows (leitura) usam o MESMO endpoint; ensureMaterialized so roda 1x.
    expect(firebirdMaterializeMock.ensureMaterialized).toHaveBeenCalledTimes(1);
    expect(firebirdMock.tableColumnsFirebird).toHaveBeenCalledWith(validEndpoint, "public", "fat_nfe");
    expect(firebirdMock.streamFirebirdRows).toHaveBeenCalled();
  });
});
