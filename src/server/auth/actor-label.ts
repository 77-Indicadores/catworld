import { prisma } from "@/server/db";
import type { Actor } from "./actor";

/** Rotulo legivel de quem fez algo (auditoria, historico): e-mail do usuario ou `token:<nome>`. Nunca lanca. */
export async function actorLabel(actor: Actor): Promise<string> {
  try {
    if (actor.type === "user") {
      const u = await prisma.user.findUnique({ where: { id: actor.id }, select: { email: true } });
      return u?.email ?? `user:${actor.id}`;
    }
    const t = await prisma.apiToken.findUnique({ where: { id: actor.id }, select: { name: true } });
    return `token:${t?.name ?? actor.id}`;
  } catch {
    return `${actor.type}:${actor.id}`;
  }
}
