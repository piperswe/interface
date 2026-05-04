FROM debian:testing

COPY --from=docker.io/cloudflare/sandbox:0.7.0 /container-server/sandbox /sandbox

RUN apt-get update \
 && apt-get install -y \
    build-essential \
    git \
    bison \
    flex \
    libncurses-dev \
    openssh-client \
    nodejs \
    npm \
	python3 \
    python-is-python3 \
    curl \
    wget \
    ca-certificates \
	&& apt-get clean -y

ENTRYPOINT ["/sandbox"]
