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

ENTRYPOINT ["/sandbox"]
