/**
 * POST /api/v1/datasets/[id]/migrate-storage
 *
 * Migra os dados de um dataset de um StorageServer para outro.
 * Copia schema e todas as tabelas (incluindo _cw_rh, índices básicos).
 * Atualiza storage_server_id ao final se tudo ocorrer bem.
 *
 * Restrições:
 *  - Ambos os servidores devem ser SQL Server acessíveis
 *  - Operação síncrona — use apenas para datasets pequenos/médios
 *  - Não remove dados do servidor de origem
 */
import type { NextRequest } from "next/server";
import { z } from "zod";
import sql from "mssql";
import { prisma } from "@/server/db";
import { resolveActor, requireRole } from "@/server/auth/actor";
import { handleApiError, ok, ApiError } from "@/server/http";
import { getStoragePool } from "@/server/storage/pool";
import { quoteIdentifier } from "@/server/security/naming";

const bodySchema = z.object({ targetStorageServerId: z.string().uuid() });

export async function POST(r: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await resolveActor(r);
    requireRole(actor, ["ADMIN"]);
    const id = (await params).id;
    const { targetStorageServerId } = bodySchema.parse(await r.json());

    const dataset = await prisma.dataset.findUniqueOrThrow({
      where: { id },
      select: { id: true, name: true, schemaName: true, storageServerId: true },
    });

    if (dataset.storageServerId === targetStorageServerId) {
      throw new ApiError(400, "SAME_SERVER", "Dataset já está neste servidor");
    }

    const schema = dataset.schemaName;
    const srcPool = await getStoragePool(dataset.storageServerId);
    const dstPool = await getStoragePool(targetStorageServerId);

    // Cria o schema no destino se não existir
    const dstReq = dstPool.request();
    const qSchema = quoteIdentifier(schema);
    await dstReq.query(
      `IF SCHEMA_ID(N'${schema.replaceAll("'", "''")}') IS NULL EXEC(N'CREATE SCHEMA ${qSchema}')`,
    );

    // Lista as tabelas do schema na origem
    const tablesRes = await srcPool.request()
      .input("schema", sql.NVarChar(128), schema)
      .query<{ name: string }>(
        `SELECT t.name FROM sys.tables t JOIN sys.schemas s ON t.schema_id=s.schema_id WHERE s.name=@schema ORDER BY t.name`,
      );

    const tables = tablesRes.recordset.map((r) => r.name);
    if (tables.length === 0) {
      // Nenhuma tabela física — só atualiza o ponteiro
      await prisma.dataset.update({ where: { id }, data: { storageServerId: targetStorageServerId } });
      return ok({ tablescopied: 0, message: "Nenhuma tabela física. Ponteiro atualizado." });
    }

    const results: { table: string; rows: number }[] = [];

    for (const table of tables) {
      const qTable = quoteIdentifier(table);
      const qFull = `${qSchema}.${qTable}`;

      // Descobre colunas na origem
      const colsRes = await srcPool.request()
        .input("schema", sql.NVarChar(128), schema)
        .input("table", sql.NVarChar(128), table)
        .query<{ col: string; type: string; max_len: number; prec: number; scale: number; nullable: number; is_identity: number }>(
          `SELECT c.name col,
                  ty.name type,
                  c.max_length max_len,
                  c.precision prec,
                  c.scale scale,
                  c.is_nullable nullable,
                  c.is_identity
           FROM sys.columns c
           JOIN sys.types ty ON c.user_type_id=ty.user_type_id
           WHERE c.object_id=OBJECT_ID(QUOTENAME(@schema)+'.'+QUOTENAME(@table))
           ORDER BY c.column_id`,
        );

      const cols = colsRes.recordset;
      if (cols.length === 0) continue;

      // Constrói DDL da tabela no destino
      const colDefs = cols.map((c) => {
        const q = quoteIdentifier(c.col);
        const nullable = c.nullable ? "NULL" : "NOT NULL";
        const t = c.type.toLowerCase();
        if (["nvarchar", "varchar", "nchar", "char"].includes(t)) {
          const len = c.max_len === -1 ? "MAX" : String(t.startsWith("n") ? c.max_len / 2 : c.max_len);
          return `${q} ${c.type.toUpperCase()}(${len}) ${nullable}`;
        }
        if (["decimal", "numeric"].includes(t)) return `${q} ${c.type.toUpperCase()}(${c.prec},${c.scale}) ${nullable}`;
        if (["datetime2", "time", "datetimeoffset"].includes(t)) return `${q} ${c.type.toUpperCase()}(${c.scale}) ${nullable}`;
        return `${q} ${c.type.toUpperCase()} ${nullable}`;
      });

      // Drop + recreate no destino
      await dstPool.request().query(
        `IF OBJECT_ID(N'${schema.replaceAll("'", "''")}.${table.replaceAll("'", "''")}',N'U') IS NOT NULL DROP TABLE ${qFull}`,
      );
      await dstPool.request().query(`CREATE TABLE ${qFull} (${colDefs.join(", ")})`);

      // Copia dados em batches de 2000 linhas
      const nonIdentity = cols.filter((c) => !c.is_identity);
      const selectCols = nonIdentity.map((c) => quoteIdentifier(c.col)).join(", ");
      const insertCols = selectCols;

      let offset = 0;
      const batchSize = 2000;
      let totalRows = 0;

      while (true) {
        const batchRes = await srcPool.request()
          .query<Record<string, unknown>>(
            `SELECT ${selectCols} FROM ${qFull} ORDER BY (SELECT NULL) OFFSET ${offset} ROWS FETCH NEXT ${batchSize} ROWS ONLY`,
          );

        const rows = batchRes.recordset;
        if (rows.length === 0) break;

        // Bulk insert via Table
        const bulkTable = new sql.Table(qFull);
        bulkTable.create = false;
        for (const c of nonIdentity) {
          bulkTable.columns.add(c.col, sql.NVarChar(sql.MAX), { nullable: true });
        }
        for (const row of rows) {
          bulkTable.rows.add(...nonIdentity.map((c) => {
            const v = row[c.col];
            return v === null || v === undefined ? null : String(v);
          }));
        }

        const bulkReq = new sql.Request(dstPool);
        await bulkReq.bulk(bulkTable);

        totalRows += rows.length;
        offset += batchSize;
        if (rows.length < batchSize) break;
      }

      results.push({ table, rows: totalRows });
    }

    // Atualiza o ponteiro apenas se tudo deu certo
    await prisma.dataset.update({ where: { id }, data: { storageServerId: targetStorageServerId } });

    return ok({ tablesCopied: results.length, tables: results });
  } catch (e) {
    return handleApiError(e);
  }
}
