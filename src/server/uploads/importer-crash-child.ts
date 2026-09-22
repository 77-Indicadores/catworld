// Processo filho do teste de crash (importer-mssql.crash.test.ts): roda importUpload e é morto com kill -9 no meio da carga.
import { importUpload } from "./importer";

const [uploadId, path] = process.argv.slice(2);
importUpload(uploadId!, path!).then(
  () => { console.log("CHILD_DONE"); process.exit(0); },
  (e) => { console.error("CHILD_ERR", e); process.exit(1); },
);
