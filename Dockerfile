# Sandbox container image.
#
# Two final stages share the same base + tooling so the cloudflare and
# fly.io backends present an identical environment to the agent:
#
#   - `cloudflare-final` (default): used by Cloudflare Containers via
#     `wrangler.jsonc`'s `containers[]` config. The cloudflare/sandbox
#     base image's built-in server handles RPC.
#
#   - `fly-final`: used by the fly.io backend. The cloudflare/sandbox
#     server is irrelevant under fly (we drive the container via the
#     Machines exec endpoint), so we override the entrypoint to start
#     the in-container preview reverse proxy on :8080 and keep the
#     container alive.
#
# Build:
#   docker build -t interface-sandbox:cf .
#   docker build --target fly-final -t registry.fly.io/$FLY_APP_NAME:latest .
FROM docker.io/cloudflare/sandbox:0.9.2 AS sandbox-base

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
    build-essential \
    git \
    bison \
    flex \
    libncurses-dev \
    openssh-client \
    nodejs \
    npm \
    python3 \
    python3-pip \
    python-is-python3 \
    ipython3 \
    python3-matplotlib \
    python3-numpy \
    python3-pandas \
    curl \
    wget \
    ca-certificates \
    file \
    golang \
    rustc \
    cargo \
    php-cli \
    ruby \
    procps \
    net-tools \
    vim \
    nano \
    neovim \
    iproute2 \
    unzip \
    zip \
    p7zip-full \
    tar \
    gzip \
    lsof \
    strace \
    htop \
    tmux \
    screen \
    zsh \
    fish \
    ripgrep \
    fd-find \
    bat \
    tree \
    default-jdk \
    cmake \
    ninja-build \
    meson \
    autoconf \
    automake \
    libtool \
    dnsutils \
    netcat-openbsd \
    jq \
    httpie \
    openssl \
    tcpdump \
    pandoc \
    libreoffice \
    ffmpeg \
    xdotool \
    imagemagick \
    rclone \
    fuse3 \
    libimage-exiftool-perl \
 && apt-get clean -y \
 && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /workspace /var/cache/rclone-vfs /var/lib/sandbox /var/log/sandbox /root/.config/rclone
RUN git config --global user.name "Interface" && git config --global user.email "interface@piperswe.me"

# --- Cloudflare final image (default target) -------------------------------
FROM sandbox-base AS cloudflare-final
# Inherits the cloudflare/sandbox entrypoint/CMD verbatim.

# --- fly.io final image ---------------------------------------------------
FROM sandbox-base AS fly-final
COPY scripts/fly-preview-proxy.mjs /opt/sandbox/fly-preview-proxy.mjs
COPY scripts/fly-entrypoint.sh /usr/local/bin/fly-entrypoint.sh
RUN chmod +x /usr/local/bin/fly-entrypoint.sh
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/fly-entrypoint.sh"]
