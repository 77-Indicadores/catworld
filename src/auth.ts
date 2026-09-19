import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { verify } from "@node-rs/argon2";
import { z } from "zod";
import { prisma } from "@/server/db";
import { auditLogin, clientIp } from "@/server/audit-request";

const credentialsSchema = z.object({ email: z.string().email(), password: z.string().min(8).max(128) });

export const { handlers, auth, signIn, signOut } = NextAuth({
  trustHost: true,
  session: { strategy: "jwt", maxAge: 8 * 60 * 60 },
  pages: { signIn: "/login" },
  providers: [Credentials({
    credentials: { email: { type: "email" }, password: { type: "password" } },
    async authorize(raw, request) {
      const ip = request ? clientIp(request as unknown as { headers: Headers }) : null;
      const parsed = credentialsSchema.safeParse(raw);
      if (!parsed.success) {
        auditLogin("LOGIN_FAILED", { ip, reason: "invalid_input" });
        return null;
      }
      const email = parsed.data.email.toLowerCase();
      const user = await prisma.user.findUnique({ where: { email } });
      if (!user?.active || !(await verify(user.passwordHash, parsed.data.password))) {
        auditLogin("LOGIN_FAILED", { userId: user?.id, email, ip, reason: !user ? "unknown_user" : !user.active ? "inactive" : "bad_password" });
        return null;
      }
      auditLogin("LOGIN_SUCCESS", { userId: user.id, email, ip });
      void prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } }).catch(() => undefined);
      return { id: user.id, name: user.name, email: user.email, role: user.role };
    },
  })],
  events: {
    signOut(message) {
      const sub = "token" in message ? (message.token?.sub as string | undefined) : undefined;
      auditLogin("LOGOUT", { userId: sub ?? null });
    },
  },
  callbacks: {
    jwt({ token, user }) { if (user) { token.sub = user.id; token.role = (user as { role: string }).role; } return token; },
    session({ session, token }) { if (session.user) { session.user.id = token.sub!; session.user.role = String(token.role ?? "VIEWER"); } return session; },
  },
});