import type { Metadata } from "next";
import { AppShell } from "@/components/layout/app-shell";
import { FeedbackProvider } from "@/components/ui/feedback";
import "./globals.css";

export const metadata: Metadata = {
  title: "Catworld",
  description: "Seu data lake, sem labirinto.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="pt-BR" data-theme="catworld" suppressHydrationWarning>
      <body>
        <FeedbackProvider>
          <AppShell>{children}</AppShell>
        </FeedbackProvider>
      </body>
    </html>
  );
}
