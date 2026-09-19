"use client";
import { useState } from "react";
import { Pencil, UserPlus } from "lucide-react";
import { useRouter } from "next/navigation";
import { apiRequest, errorMessage } from "@/lib/api-client";
import { useDialog, ModalBackdrop } from "@/components/ui/modal";

const roles = ["ADMIN", "DATA_MANAGER", "ANALYST", "VIEWER"];

export function CreateUserDialog() {
  const { ref, open, close } = useDialog();
  const router = useRouter();
  const [error, setError] = useState("");
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError("");
    const form = e.currentTarget;
    const f = new FormData(form);
    try {
      await apiRequest("/api/v1/users", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: f.get("name"), email: f.get("email"), password: f.get("password"), role: f.get("role") }),
      });
    } catch (err) {
      setError(errorMessage(err));
      return;
    }
    form.reset();
    close();
    router.refresh();
  }
  return (
    <>
      <button onClick={open} className="btn btn-primary btn-sm"><UserPlus size={15} />Novo usuário</button>
      <dialog ref={ref} className="modal">
        <form onSubmit={submit} className="modal-box">
          <h3 className="text-lg font-bold">Novo usuário</h3>
          <div className="mt-5 space-y-4">
            <input name="name" required minLength={2} placeholder="Nome" className="input w-full" />
            <input name="email" type="email" required placeholder="Email" className="input w-full" />
            <input name="password" type="password" required minLength={12} maxLength={128} placeholder="Senha (mín. 12 caracteres)" className="input w-full" />
            <select name="role" className="select w-full" defaultValue="VIEWER">{roles.map(r => <option key={r} value={r}>{r}</option>)}</select>
          </div>
          {error && <div className="alert alert-error alert-soft mt-4">{error}</div>}
          <div className="modal-action">
            <button type="button" onClick={close} className="btn btn-ghost btn-sm">Cancelar</button>
            <button className="btn btn-primary btn-sm">Criar</button>
          </div>
        </form>
        <ModalBackdrop onClose={close} />
      </dialog>
    </>
  );
}

export function EditUserDialog({ id, name, role, active }: { id: string; name: string; role: string; active: boolean }) {
  const { ref, open, close } = useDialog();
  const router = useRouter();
  const [error, setError] = useState("");
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError("");
    const f = new FormData(e.currentTarget);
    const password = String(f.get("password") ?? "");
    try {
      await apiRequest(`/api/v1/users/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: f.get("name"), role: f.get("role"), active: f.get("active") === "on", ...(password ? { password } : {}) }),
      });
    } catch (err) {
      setError(errorMessage(err));
      return;
    }
    close();
    router.refresh();
  }
  return (
    <>
      <button onClick={open} className="btn btn-ghost btn-xs"><Pencil size={13} />Editar</button>
      <dialog ref={ref} className="modal">
        <form onSubmit={submit} className="modal-box">
          <h3 className="text-lg font-bold">Editar usuário</h3>
          <div className="mt-5 space-y-4">
            <input name="name" required minLength={2} defaultValue={name} placeholder="Nome" className="input w-full" />
            <select name="role" className="select w-full" defaultValue={role}>{roles.map(r => <option key={r} value={r}>{r}</option>)}</select>
            <input name="password" type="password" minLength={12} maxLength={128} placeholder="Nova senha (deixe em branco para manter)" className="input w-full" />
            <label className="label cursor-pointer justify-start gap-3"><input type="checkbox" name="active" defaultChecked={active} className="toggle toggle-sm" /><span className="label-text">Ativo</span></label>
          </div>
          {error && <div className="alert alert-error alert-soft mt-4">{error}</div>}
          <div className="modal-action">
            <button type="button" onClick={close} className="btn btn-ghost btn-sm">Cancelar</button>
            <button className="btn btn-primary btn-sm">Salvar</button>
          </div>
        </form>
        <ModalBackdrop onClose={close} />
      </dialog>
    </>
  );
}
