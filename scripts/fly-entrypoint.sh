#!/usr/bin/env bash
# Entrypoint for the fly.io machine image.
# Starts the preview reverse proxy on :8080, then drops into a long-lived
# sleep so the Machine stays up for the Machines API exec endpoint. We
# don't run the cloudflare/sandbox server here — fly uses the Machines
# REST/exec API directly, not the sandbox SDK protocol.
set -euo pipefail

mkdir -p /var/log/sandbox
nohup node /opt/sandbox/fly-preview-proxy.mjs \
  >> /var/log/sandbox/preview-proxy.log 2>&1 &
PROXY_PID=$!
echo "[fly-entrypoint] preview proxy pid=$PROXY_PID"

# Keep the container alive. The Machines exec endpoint can run arbitrary
# commands inside this PID 1 process tree.
exec tail -f /dev/null
