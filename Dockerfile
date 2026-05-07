FROM docker.io/cloudflare/sandbox:0.9.2

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
