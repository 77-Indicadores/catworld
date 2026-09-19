-- Aditiva: quem criou o token e o ultimo login do usuario (ambas opcionais).
ALTER TABLE "cw_tokens" ADD COLUMN IF NOT EXISTS "created_by" VARCHAR(255);
ALTER TABLE "cw_users" ADD COLUMN IF NOT EXISTS "last_login_at" TIMESTAMP(3);
