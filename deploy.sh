#!/usr/bin/env bash
# Ship the committed tree to the Oracle VM and rebuild the stack.
# The tarball excludes .git and (by git's own rules) .env.prod, so secrets on the
# VM survive every redeploy. Run from the repo root on your laptop:
#
#   VM_IP=<public-ip> ./deploy.sh
#   SSH_KEY=~/.ssh/oracle_key VM_IP=<public-ip> ./deploy.sh   # custom key
#
set -euo pipefail

: "${VM_IP:?export VM_IP=<oracle VM public IP>}"
KEY="${SSH_KEY:-$HOME/.ssh/oracle_key}"
USER="${VM_USER:-ubuntu}"

echo "==> Archiving HEAD..."
git archive --format=tar.gz -o /tmp/desk.tgz HEAD

echo "==> Copying to ${USER}@${VM_IP}..."
scp -i "$KEY" /tmp/desk.tgz "${USER}@${VM_IP}:/tmp/"

echo "==> Unpacking + rebuilding on the VM..."
ssh -i "$KEY" "${USER}@${VM_IP}" '
  set -e
  mkdir -p ~/app && cd ~/app && tar xzf /tmp/desk.tgz
  if [ ! -f .env.prod ] || [ ! -f .env ]; then
    echo "!! Missing .env and/or .env.prod on the VM — create them first (see DEPLOY_ORACLE.md)"; exit 1
  fi
  docker compose -f docker-compose.prod.yml up -d --build > ~/deploy.log 2>&1
  tail -n 20 ~/deploy.log
  docker compose -f docker-compose.prod.yml ps
'
echo "==> Done. Verify: curl https://<name>.duckdns.org/health"
