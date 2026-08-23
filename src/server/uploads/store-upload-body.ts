import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, pipeline as streamPipeline } from "node:stream";
import { promisify } from "node:util";
import { createGunzip } from "node:zlib";
import type { Upload } from "@prisma/client";
import { prisma } from "@/server/db";
import { ApiError } from "@/server/http";
import { writeFile } from "@/server/storage";

const pipeline = promisify(streamPipeline);

type BodyLike = ReadableStream<Uint8Array>;

async function md5(path: string) {
  const hash = createHash("md5");
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

export async function storeUploadBody(upload: Upload, body: BodyLike, contentEncoding: string | null) {
  const tmpPath = join(tmpdir(), `cw-upload-${upload.id}-${Date.now()}.tmp`);
  try {
    const source = Readable.fromWeb(body as Parameters<typeof Readable.fromWeb>[0]);
    const input = contentEncoding === "gzip" ? source.pipe(createGunzip()) : source;
    await pipeline(input, createWriteStream(tmpPath));

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
