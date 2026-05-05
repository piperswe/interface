# Base on the official sandbox image's python variant — it bundles the
# `/container-server/sandbox` server, the JavaScript / TypeScript / Python
# runtime executors, an ipython-capable Python 3.11 toolchain, and Node.js.
# The plain `cloudflare/sandbox:<ver>` tag has Python disabled (no python3
# binary), which is what produced the
#   Failed to create code context: ENOENT: ... posix_spawn 'python3'
# error. Keep this version in lockstep with the @cloudflare/sandbox npm
# package version in package.json.
FROM docker.io/cloudflare/sandbox:0.9.2-python

# Extra tooling the agent expects at runtime: a C toolchain, git over SSH,
# and a few libs for building things from source inside the sandbox.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
    build-essential \
    git \
    bison \
    flex \
    libncurses-dev \
    openssh-client \
    wget \
 && apt-get clean -y \
 && rm -rf /var/lib/apt/lists/*

# Ports commonly used by dev servers inside the sandbox (required for
# local `wrangler dev` preview exposure; ignored in production).
EXPOSE 3001
EXPOSE 4000
EXPOSE 4200
EXPOSE 5000
EXPOSE 5173
EXPOSE 8000
EXPOSE 8080
EXPOSE 9000
EXPOSE 9001
