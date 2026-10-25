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
  # files that used to ship in the web folder must not linger from earlier deploys (tar only adds, never removes)
  rm -f frontend/public/data/knowledge.json frontend/dist/data/knowledge.json
  if [ ! -f .env.prod ] || [ ! -f .env ]; then
    echo "!! Missing .env and/or .env.prod on the VM — create them first (see DEPLOY_ORACLE.md)"; exit 1
  fi
  # The swap of the old container can fail ("cannot remove container ... is running") and leave the app
  # stopped. The image is already built by then, so clear the stale containers and start again.
  if ! docker compose -f docker-compose.prod.yml up -d --build > ~/deploy.log 2>&1; then
    echo "!! compose up failed, clearing stale app containers and retrying" | tee -a ~/deploy.log
    docker rm -f $(docker ps -aq --filter name=app-app) >> ~/deploy.log 2>&1 || true
    docker compose -f docker-compose.prod.yml up -d >> ~/deploy.log 2>&1
  fi
  tail -n 20 ~/deploy.log
  docker compose -f docker-compose.prod.yml ps
'
echo "==> Done. Verify: curl https://<name>.duckdns.org/health"
