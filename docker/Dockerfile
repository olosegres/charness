# The whole bot in one container (plan "Jira prompt context" S8): the bot, tmux, every agent it starts and the
# OpenCode server run in here, as on a host. The image holds only the OS tools they need — no bot code (the
# checkout is mounted at /opt/telegramcode) and no agent CLI (the bot installs Claude Code / OpenCode into the
# mounted home, where they update and persist).
#
#   docker build -t telegramcode -f docker/Dockerfile .      # from the checkout: its package.json names yarn
FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      tini tmux git openssh-client ffmpeg ripgrep procps iproute2 ca-certificates curl \
      python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

# yarn exactly as the checkout's package.json (packageManager) names it, fetched once at build time: HOME is a mount,
# so a cache there would start empty on a fresh home, and the checkout's yarn needs no download — nor a write into
# a root-owned folder — when the container runs as a non-root `--user`. The cache stays writable for any user: the
# agents' projects name other yarn versions, which a non-root user must be able to fetch.
ENV COREPACK_HOME=/opt/corepack
COPY package.json /tmp/checkout/package.json
RUN cd /tmp/checkout && corepack enable && corepack install \
 && rm -rf /tmp/checkout \
 && chmod -R a+rwX /opt/corepack

# HOME is the mounted agents' home: their Claude / OpenCode login, transcripts and CLI installs.
# IS_SANDBOX lets Claude Code's --dangerously-skip-permissions run as root — the container's root, which is the
# host user under rootless Docker.
ENV HOME=/home/telegramcode \
    NPM_CONFIG_PREFIX=/home/telegramcode/.npm-global \
    PATH=/home/telegramcode/.npm-global/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    LANG=C.UTF-8 \
    TERM=xterm-256color \
    IS_SANDBOX=1
RUN mkdir -p /home/telegramcode /opt/telegramcode

COPY docker/entrypoint.sh /usr/local/bin/telegramcode-entrypoint
COPY docker/restart-bot.sh /usr/local/bin/telegramcode-restart-bot
RUN chmod 755 /usr/local/bin/telegramcode-entrypoint /usr/local/bin/telegramcode-restart-bot

WORKDIR /opt/telegramcode
# tini is PID 1: it reaps the tmux server and the OpenCode server, which leave the bot's process tree by design.
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/telegramcode-entrypoint"]
