#!/usr/bin/env bash
# Primera instalación en una VM Ubuntu limpia (Azure, AWS, etc.).
#   bash deploy/setup-vm.sh billetera-demo.brazilsouth.cloudapp.azure.com
# Instala Docker, genera deploy/.env con secretos aleatorios y levanta todo.
set -euo pipefail
DOMAIN="${1:?Uso: setup-vm.sh <dominio>}"
cd "$(dirname "$0")"

if ! command -v docker >/dev/null; then
  curl -fsSL https://get.docker.com | sudo sh
  sudo usermod -aG docker "$USER"
fi

# Swap: la compilación de la imagen necesita más memoria que la que usan los servicios.
if ! swapon --show | grep -q swapfile; then
  sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
  echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
fi

hex() { openssl rand -hex "$1"; }
if [ ! -f .env ]; then
  MAIL_PASS=$(hex 8)
  ADMIN_PASS="Adm-$(hex 6)"
  sed \
    -e "s|__DOMAIN__|$DOMAIN|g" \
    -e "s|__DB_PASSWORD__|$(hex 16)|" \
    -e "s|__RABBITMQ_PASSWORD__|$(hex 16)|" \
    -e "s|__JWT_ACCESS_SECRET__|$(hex 32)|" \
    -e "s|__OTP_SECRET__|$(hex 32)|" \
    -e "s|__INTERNAL_API_KEY__|$(hex 24)|" \
    -e "s|__CARD_ENCRYPTION_KEY__|$(hex 32)|" \
    -e "s|__KYC_ENCRYPTION_KEY__|$(hex 32)|" \
    -e "s|__QR_SIGNING_SECRET__|$(hex 32)|" \
    -e "s|__CARD_ACQUIRER_KEY__|acq_$(hex 20)|" \
    -e "s|__ADMIN_PASSWORD__|$ADMIN_PASS|" \
    -e "s|__MAILPIT_UI_AUTH__|correo:$MAIL_PASS|" \
    .env.example > .env
  chmod 600 .env
  echo "deploy/.env creado. Admin: $(grep ^ADMIN_EMAIL= .env | cut -d= -f2) / $ADMIN_PASS"
  echo "Bandeja de correos: https://$DOMAIN/correo/  (usuario: correo / clave: $MAIL_PASS)"
fi

sudo docker compose up -d --build
echo "Listo: https://$DOMAIN"
