import { describe, expect, it, vi } from "vitest";

// Conexao salva com espaco antes do host (" vps-139-001.somosbr.app") dava ENOTFOUND em toda consulta. As rotas aparam os campos.
const saved = vi.hoisted(() => ({ data: null as Record<string, unknown> | null }));
vi.mock("@/server/db", () => ({
  prisma: {
    connection: {
      findUnique: async () => ({ id: "c1", provider: "mssql", metadataJson: null, sshTunnelEnabled: false }),
      findUniqueOrThrow: async () => ({ id: "c1", provider: "mssql", metadataJson: null, sshTunnelEnabled: false }),
      update: async (args: { data: Record<string, unknown> }) => { saved.data = args.data; return { id: "c1", ...args.data }; },
    },
  },
}));
vi.mock("@/server/auth/actor", () => ({ resolveActor: async () => ({ type: "user", role: "ADMIN", principal: "u" }), requireRole: () => {} }));
vi.mock("@/server/audit", () => ({ audit: async () => {} }));

describe("PATCH /connections/:id apara espacos", { timeout: 60_000 }, () => {
  it("host, banco e usuario sem espacos nas pontas", async () => {
    const { PATCH } = await import("./[id]/route");
    const { NextRequest } = await import("next/server");
    const res = await PATCH(
      new NextRequest("http://localhost/api/v1/connections/c1", { method: "PATCH", body: JSON.stringify({ server: " vps-139-001.somosbr.app ", databaseName: " erp\t", username: " leitor " }) }),
      { params: Promise.resolve({ id: "c1" }) },
    );
    expect(res.status).toBeLessThan(300);
    expect(saved.data).toMatchObject({ server: "vps-139-001.somosbr.app", databaseName: "erp", username: "leitor" });
  });
});
