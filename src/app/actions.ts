"use server";
import { signOut } from "@/auth";

/** Encerra a sessão e volta ao login (o evento LOGOUT é gravado pela auditoria). */
export async function signOutAction() {
  await signOut({ redirectTo: "/login" });
}
