# Image for the agent loop's sandbox: setup, gates and agent sessions run in it.
# Build: docker build -t chat-bridge-agent:1 docker/agent-sandbox
FROM node:22-bookworm-slim

# git for the agent, build tools in case better-sqlite3 has no prebuilt binary.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

# The real pnpm, not corepack's shim: gates have no network to download it.
RUN corepack disable && npm install --global --force pnpm@11.28.9

# Antigravity CLI for the agent sessions. The installer always fetches the latest
# version; the loop logs which one ran, so rebuild on purpose to upgrade.
RUN curl -fsSL https://antigravity.google/cli/install.sh -o /tmp/install.sh \
 && HOME=/tmp/agy-install bash /tmp/install.sh --dir /usr/local/bin \
 && rm -rf /tmp/install.sh /tmp/agy-install \
 && agy --version

# Claude Code, for runner "claude-code". Same rule: rebuild on purpose to upgrade.
RUN npm install --global @anthropic-ai/claude-code \
 && claude --version
