FROM debian:unstable

# Pull the sandbox server binary AND its bundled runtime executors from the
# official image. The 0.9.x SDK's interpreter spawns python3 / node via
# scripts at /container-server/dist/runtime/executors/{python,javascript}/...
# which weren't being copied before — that's what produced
#   Failed to create code context: ENOENT: ... posix_spawn 'python3'
# (the server couldn't find the executor and reported it as a missing
# python3). Keep this tag in lockstep with the @cloudflare/sandbox npm
# package version in package.json.
COPY --from=docker.io/cloudflare/sandbox:0.9.2-python /container-server /container-server

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
    eza \
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
    xh \
    openssl \
    tcpdump \
    pandoc \
    libreoffice \
    chromium \
    firefox-esr \
    ffmpeg \
    xdotool \
    imagemagick \
    task-lxqt-desktop \
    s3fs \
 && apt-get clean -y \
 && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /workspace

WORKDIR /container-server

# Match the official image's interpreter pool sizing so all three pools are
# warmed at startup.
ENV PYTHON_POOL_MIN_SIZE=3 \
    JAVASCRIPT_POOL_MIN_SIZE=3 \
    TYPESCRIPT_POOL_MIN_SIZE=3

# Ports commonly used by dev servers inside the sandbox (required for
# local `wrangler dev` preview exposure; ignored in production).
EXPOSE 3000
EXPOSE 3001
EXPOSE 4000
EXPOSE 4200
EXPOSE 5000
EXPOSE 5173
EXPOSE 8000
EXPOSE 8080
EXPOSE 9000
EXPOSE 9001

ENTRYPOINT ["/container-server/sandbox"]
