"use client";

import * as Sentry from "@sentry/nextjs";
import { useEffect } from "react";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <html lang="pt-BR">
      <body style={{ fontFamily: "system-ui, sans-serif", margin: 0, minHeight: "100vh", display: "grid", placeItems: "center", padding: "24px" }}>
        <main role="alert" style={{ maxWidth: 440 }}>
          <h1 style={{ fontSize: 22, margin: "0 0 8px" }}>Algo deu errado</h1>
          <p style={{ margin: "0 0 16px", lineHeight: 1.5 }}>
            Não foi possível carregar esta página. Tente de novo; se o problema continuar, informe o código abaixo ao suporte.
          </p>
          {error.digest && <p style={{ margin: "0 0 16px", fontFamily: "monospace", fontSize: 13 }}>Código: {error.digest}</p>}
          <button onClick={reset} style={{ padding: "8px 16px", fontSize: 15, cursor: "pointer" }}>Tentar novamente</button>
        </main>
      </body>
    </html>
  );
}
