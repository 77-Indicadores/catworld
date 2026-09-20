import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extname } from "node:path";
import { Readable, Transform, pipeline as streamPipeline } from "node:stream";
import { promisify } from "node:util";
import { createGunzip } from "node:zlib";
import type { Upload } from "@prisma/client";
import { prisma } from "@/server/db";
import { ApiError } from "@/server/http";
import { writeFile } from "@/server/storage";
import { getUploadLimits } from "@/server/worker/config";

const pipeline = promisify(streamPipeline);

type BodyLike = ReadableStream<Uint8Array>;

async function md5(path: string) {
  const hash = createHash("md5");
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

/** Conta bytes (apos gunzip) e aborta com 413 assim que passar do limite, sem esperar o fim do stream. */
function limitStream(maxBytes: number, xlsxMaxBytes: number | null) {
  let seen = 0;
  return new Transform({
    transform(chunk: Buffer, _enc, cb) {
      seen += chunk.length;
      if (xlsxMaxBytes !== null && seen > xlsxMaxBytes) {
        const mb = Math.round(xlsxMaxBytes / (1024 * 1024));
        return cb(new ApiError(413, "XLSX_TOO_LARGE", `Arquivos XLSX/XLS acima de ${mb}MB nao sao suportados (lidos inteiros em memoria) — exporte como CSV.`));
      }
      if (seen > maxBytes) return cb(new ApiError(413, "FILE_TOO_LARGE", "Arquivo excede o limite configurado"));
      cb(null, chunk);
    },
  });
}

export async function storeUploadBody(upload: Upload, body: BodyLike, contentEncoding: string | null) {
  const tmpPath = join(tmpdir(), `cw-upload-${upload.id}-${Date.now()}.tmp`);
  try {
    const source = Readable.fromWeb(body as Parameters<typeof Readable.fromWeb>[0]);
    const limits = await getUploadLimits();
    const ext = extname(upload.originalFilename).toLowerCase();
    const guard = limitStream(limits.maxBytes, ext === ".xlsx" || ext === ".xls" ? limits.xlsxMaxBytes : null);
    // pipeline (nao .pipe) para propagar erro/abort de qualquer etapa e destruir os streams
    if (contentEncoding === "gzip") await pipeline(source, createGunzip(), guard, createWriteStream(tmpPath));
    else await pipeline(source, guard, createWriteStream(tmpPath));

    const [fileStat, fileHash] = await Promise.all([stat(tmpPath), md5(tmpPath)]);
    if (BigInt(fileStat.size) !== upload.sizeBytes) {
      throw new ApiError(
        400,
        "UPLOAD_SIZE_MISMATCH",
        `Upload recebido com ${fileStat.size} bytes, esperado ${upload.sizeBytes.toString()}`,
      );
    }
    if (upload.fileHash && upload.fileHash.toLowerCase() !== fileHash) {
      throw new ApiError(400, "UPLOAD_HASH_MISMATCH", "Hash do arquivo recebido nao confere com o upload criado");
    }

    await writeFile(upload.blobName, Readable.toWeb(createReadStream(tmpPath)) as ReadableStream<Uint8Array>);

    if (!upload.fileHash) {
      await prisma.upload.update({ where: { id: upload.id }, data: { fileHash } });
    }

    return { stored: true, sizeBytes: fileStat.size, fileHash };
  } finally {
    await rm(tmpPath, { force: true }).catch(() => {});
  }
}
