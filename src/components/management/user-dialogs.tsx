"use client";
import { Pencil, UserPlus } from "lucide-react";
import { useRouter } from "next/navigation";
import { apiRequest } from "@/lib/api-client";
import { FormDialog } from "@/components/ui/form-dialog";

const roles = ["ADMIN", "DATA_MANAGER", "ANALYST", "VIEWER"];

export function CreateUserDialog() {
  const router = useRouter();

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    const f = new FormData(e.currentTarget);
    await apiRequest("/api/v1/users", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: f.get("name"), email: f.get("email"), password: f.get("password"), role: f.get("role") }),
    });
    router.refresh();
  }

  return (
    <FormDialog
      trigger={(open) => <button onClick={open} className="btn btn-primary btn-sm"><UserPlus size={15} />Novo usuário</button>}
      title="Novo usuário"
      submitLabel="Criar"
      savingLabel="Criando…"
      onSubmit={submit}
    >
      <input name="name" required minLength={2} placeholder="Nome" className="input w-full" />
      <input name="email" type="email" required placeholder="Email" className="input w-full" />
      <input name="password" type="password" required minLength={12} maxLength={128} placeholder="Senha (mín. 12 caracteres)" className="input w-full" />
      <select name="role" className="select w-full" defaultValue="VIEWER">{roles.map(r => <option key={r} value={r}>{r}</option>)}</select>
    </FormDialog>
  );
}

export function EditUserDialog({ id, name, role, active }: { id: string; name: string; role: string; active: boolean }) {
  const router = useRouter();

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    const f = new FormData(e.currentTarget);
    const password = String(f.get("password") ?? "");
    await apiRequest(`/api/v1/users/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: f.get("name"), role: f.get("role"), active: f.get("active") === "on", ...(password ? { password } : {}) }),
    });
    router.refresh();
  }

  return (
    <FormDialog
      trigger={(open) => <button onClick={open} className="btn btn-ghost btn-xs"><Pencil size={13} />Editar</button>}
      title="Editar usuário"
      submitLabel="Salvar"
      onSubmit={submit}
    >
      <input name="name" required minLength={2} defaultValue={name} placeholder="Nome" className="input w-full" />
      <select name="role" className="select w-full" defaultValue={role}>{roles.map(r => <option key={r} value={r}>{r}</option>)}</select>
      <input name="password" type="password" minLength={12} maxLength={128} placeholder="Nova senha (deixe em branco para manter)" className="input w-full" />
      <label className="label cursor-pointer justify-start gap-3"><input type="checkbox" name="active" defaultChecked={active} className="toggle toggle-sm" /><span className="label-text">Ativo</span></label>
    </FormDialog>
  );
}
