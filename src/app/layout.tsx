import type { Metadata } from "next";
import { AppShell, type ShellUser } from "@/components/layout/app-shell";
import { FeedbackProvider } from "@/components/ui/feedback";
import { auth } from "@/auth";
import { prisma } from "@/server/db";
import { signOutAction } from "./actions";
import "./globals.css";

export const metadata: Metadata = {
  title: "Catworld",
  description: "Seu data lake, sem labirinto.",
};

// Aplica o tema salvo (ou a preferência do sistema) ANTES da primeira pintura, para não piscar no tema errado.
const THEME_SCRIPT = `try{var t=localStorage.getItem("cw-theme");var d=t?t==="dark":window.matchMedia("(prefers-color-scheme: dark)").matches;document.documentElement.setAttribute("data-theme",d?"catworld-dark":"catworld")}catch(e){}`;

/** Usuário logado (papel e ativo vêm do banco, como nas rotas). Sem sessão válida: null. */
async function currentShellUser(): Promise<ShellUser> {
  try {
    const session = await auth();
    if (!session?.user?.id) return null;
    const user = await prisma.user.findUnique({ where: { id: session.user.id }, select: { name: true, email: true, role: true, active: true } });
    return user?.active ? { name: user.name, email: user.email, role: user.role } : null;
  } catch {
    return null; // banco fora do ar: a página ainda renderiza (sem menu por papel)
  }
}

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const user = await currentShellUser();
  return (
    <html lang="pt-BR" data-theme="catworld" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body>
        <FeedbackProvider>
          <AppShell user={user} signOutAction={signOutAction}>{children}</AppShell>
        </FeedbackProvider>
      </body>
    </html>
  );
}
