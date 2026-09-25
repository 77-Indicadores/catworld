FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package*.json ./
RUN npm install

FROM deps AS proddeps
RUN npm prune --omit=dev

FROM deps AS builder
COPY . .
RUN npx prisma generate && npm run build

FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
# Fuso fixo em UTC: datas/timestamps e marcas d'agua nunca dependem do fuso do host (docs/estudo-confiabilidade-dados.md, FON-03/ENT-06)
ENV TZ=UTC
# firebird-ftp (docs/firebird-ftp-provider.md): CONFIRMADO contra o backup real do TMK (2026-09-22, sessao
# principal) que o arquivo que esses clientes mandam por FTP e uma COPIA BRUTA de um .fdb ao vivo (nao um backup
# logico do gbak) em ODS 13 (Firebird 4.0/5.0) — abrir direto com Firebird.attachAsync, sem nenhum passo de
# restore. Debian bookworm so tem Firebird 3.0 (ODS 12) no apt, que RECUSA abrir esse arquivo ("Wrong ODS
# version, expected 12, encountered 13"); por isso o Firebird 5.0.x oficial e instalado via tarball (nao existe
# pacote apt pra ele no bookworm). unzip: descompacta o ZIP baixado do FTP. curl: baixa o tarball do GitHub
# Releases (removido do runtime final junto com o proprio tarball, so serve pra instalar). procps e libtommath1:
# dependencias de runtime do install.sh/fbguard do tarball oficial (nao vem no bookworm-slim; sem elas o
# install.sh aborta com "Please install required library 'tommath' before firebird" — confirmado com
# `docker build` real em 2026-09-25).
RUN DEBIAN_FRONTEND=noninteractive apt-get update && apt-get install -y --no-install-recommends \
      libreoffice-calc ca-certificates unzip curl procps libtommath1 \
    && rm -rf /var/lib/apt/lists/* \
    && curl -fsSL -o /tmp/firebird.tar.gz https://github.com/FirebirdSQL/firebird/releases/download/v5.0.4/Firebird-5.0.4.1812-0-linux-x64.tar.gz \
    && mkdir -p /tmp/firebird-install \
    && tar -xzf /tmp/firebird.tar.gz -C /tmp/firebird-install --strip-components=1 \
    && cd /tmp/firebird-install && ./install.sh -silent \
    && cd / && rm -rf /tmp/firebird.tar.gz /tmp/firebird-install
COPY --from=proddeps /app/node_modules ./node_modules
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/src ./src
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/tsconfig.json ./tsconfig.json
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/scripts ./scripts
COPY docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x ./docker-entrypoint.sh
EXPOSE 3000
ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node","server.js"]