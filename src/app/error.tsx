"use client";

import { useEffect } from "react";
import * as Sentry from "@sentry/nextjs";
import { CircleAlert } from "lucide-react";
import { EmptyState, Panel } from "@/components/ui/primitives";

/** Erro dentro de qualquer página (o menu continua): explica, dá o código de suporte e permite tentar de novo. */
export default function PageError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <Panel>
      <EmptyState
        icon={<CircleAlert size={26} />}
        title="Não foi possível carregar esta página"
        description={`Tente de novo. Se continuar, informe ao suporte${error.digest ? ` o código ${error.digest}` : " o horário do erro"}.`}
        action={<button className="btn btn-primary btn-sm" onClick={reset}>Tentar novamente</button>}
      />
    </Panel>
  );
}
