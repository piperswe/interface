FROM docker.io/cloudflare/sandbox:0.7.0-python

RUN apt-get update \
 && apt-get install -y build-essential git bison flex libncurses-dev openssh-client
