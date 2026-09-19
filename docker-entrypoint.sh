#!/bin/sh
# Roda as migrations pendentes antes de subir o processo (web ou workers). `prisma migrate deploy`
# usa lock consultivo no banco, então é seguro os dois serviços chamarem isso ao mesmo tempo num
# deploy: quem chegar primeiro aplica, o outro espera e não encontra nada pendente.
set -e
npx prisma migrate deploy
exec "$@"
