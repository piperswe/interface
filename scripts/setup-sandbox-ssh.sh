#!/usr/bin/env bash
set -euo pipefail

# setup-sandbox-ssh.sh
#
# Generate a new Ed25519 SSH key for sandbox-to-GitHub access and upload it
# as the Wrangler secret SANDBOX_SSH_KEY.
#
# Usage:
#   ./scripts/setup-sandbox-ssh.sh
#
# After running this script, add the resulting public key to GitHub:
#   https://github.com/settings/ssh/new

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
KEY_DIR="${REPO_ROOT}/.sandbox-ssh"
PRIV_KEY="${KEY_DIR}/sandbox_key"
PUB_KEY="${KEY_DIR}/sandbox_key.pub"

mkdir -p "${KEY_DIR}"

if [[ -f "${PRIV_KEY}" ]]; then
  echo "⚠️  Private key already exists at ${PRIV_KEY}"
  echo "   Remove it first if you want to regenerate."
else
  echo "🔑 Generating Ed25519 key pair for sandbox access..."
  ssh-keygen -t ed25519 -C "interface-sandbox-$(date +%Y-%m-%d)" -f "${PRIV_KEY}" -N ""
  echo "✅ Key pair generated:"
  echo "   Private: ${PRIV_KEY}"
  echo "   Public:  ${PUB_KEY}"
fi

echo ""
echo "📤 Uploading private key as Wrangler secret SANDBOX_SSH_KEY..."
wrangler secret put SANDBOX_SSH_KEY --name interface < "${PRIV_KEY}"

echo ""
echo "🎓 Next steps:"
echo "   1. Add the public key to your GitHub account:"
echo "      https://github.com/settings/ssh/new"
echo ""
echo "   2. The public key to paste is:"
cat "${PUB_KEY}"
echo ""
echo "   3. After adding to GitHub, the sandbox will be able to clone, pull, and push"
echo "      to repositories your account has access to."
