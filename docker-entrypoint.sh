#!/bin/sh
# Roda as migrations pendentes antes de subir o processo (web ou workers). `prisma migrate deploy`
# usa lock consultivo no banco, então é seguro os dois serviços chamarem isso ao mesmo tempo num
# deploy: quem chegar primeiro aplica, o outro espera e não encontra nada pendente.
set -e
npx prisma migrate deploy

# firebird-ftp (docs/firebird-ftp-provider.md): um UNICO servidor Firebird sempre no ar na imagem, atendendo
# varios .fdb por caminho de arquivo (nao por alias registrado) — nao sobe/derruba processo por conexao; o
# codigo de materializacao so cria/apaga arquivos .fdb nele (a copia bruta extraida do zip do FTP e aberta
# DIRETO, sem gbak — ver nota no Dockerfile e docs/firebird-ftp-provider.md, corrigido 2026-09-22 contra o
# backup real do TMK: ODS 13, Firebird 4.0/5.0). Instalado via tarball oficial em /opt/firebird (Dockerfile),
# nao pelo pacote apt do Debian (que so tem a serie 3.0/ODS 12, incompativel). Sobe aqui, em segundo plano,
# SOMENTE se a senha do SYSDBA estiver configurada (instalacoes sem nenhuma conexao firebird-ftp nao precisam).
#
# NAO PROVADO EM CONTAINER REAL (worktree sem Docker) — escrito com base na documentacao do instalador tarball
# oficial da Firebird Foundation; precisa de um `docker build` + `docker run` de verdade para validar antes de
# producao, principalmente: (1) o nome/local exatos do binario de servico de longa duracao nesta versao (o
# instalador tarball tradicionalmente chama `fbguard`, mas confirme em /opt/firebird/bin apos o `install.sh
# -silent` rodar), (2) se `/opt/firebird/SYSDBA.password` e criado no MESMO formato (linha com a senha entre
# aspas) que o pacote Debian usava — se o formato for outro, o grep abaixo nao acha a senha default e o aviso
# de "nao foi possivel trocar" aparece (nesse caso, trocar para ler o arquivo como texto puro).
FIREBIRD_BIN=/opt/firebird/bin
if [ -n "$CATWORLD_FIREBIRD_SYSDBA_PASSWORD" ] && [ -x "$FIREBIRD_BIN/fbguard" ]; then
  DEFAULT_PW_FILE=/opt/firebird/SYSDBA.password
  # 1a inicializacao (arquivo do instalador ainda tem a senha aleatoria gerada no build/1o boot): troca para a
  # nossa via gsec contra a security database viva — o arquivo sozinho é só documentação, gsec precisa do
  # servidor de pé para autenticar e regravar a security database.
  if [ -f "$DEFAULT_PW_FILE" ]; then
    DEFAULT_PW=$(grep -oE '"[^"]+"' "$DEFAULT_PW_FILE" | head -1 | tr -d '"')
    [ -z "$DEFAULT_PW" ] && DEFAULT_PW=$(tr -d '\n\r ' < "$DEFAULT_PW_FILE")
    if [ -n "$DEFAULT_PW" ]; then
      "$FIREBIRD_BIN/fbguard" -daemon -forever &
      FB_BOOTSTRAP_PID=$!
      # Espera o servidor aceitar conexao antes do gsec (ate 30s) — subir e ficar pronto para autenticar nao e instantaneo.
      i=0
      while [ "$i" -lt 30 ]; do
        if "$FIREBIRD_BIN/gsec" -user sysdba -password "$DEFAULT_PW" -display >/dev/null 2>&1; then break; fi
        i=$((i + 1))
        sleep 1
      done
      if "$FIREBIRD_BIN/gsec" -user sysdba -password "$DEFAULT_PW" -modify sysdba -pw "$CATWORLD_FIREBIRD_SYSDBA_PASSWORD" >/dev/null 2>&1; then
        rm -f "$DEFAULT_PW_FILE"
        echo "[entrypoint] senha do SYSDBA do Firebird definida a partir de CATWORLD_FIREBIRD_SYSDBA_PASSWORD"
      else
        echo "[entrypoint] aviso: nao foi possivel trocar a senha padrao do SYSDBA (pode ja ter sido trocada num boot anterior, num volume persistente)" >&2
      fi
      kill "$FB_BOOTSTRAP_PID" 2>/dev/null || true
      wait "$FB_BOOTSTRAP_PID" 2>/dev/null || true
    fi
  fi
  # Servidor definitivo, em segundo plano — NUNCA como PID 1: `exec "$@"` abaixo precisa continuar sendo o PID 1
  # para receber SIGTERM/SIGINT corretamente (senao o container nao encerra limpo).
  "$FIREBIRD_BIN/fbguard" -daemon -forever &
fi

exec "$@"
