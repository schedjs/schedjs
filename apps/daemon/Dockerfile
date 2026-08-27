# syntax=docker/dockerfile:1.7
# Official sched daemon image — built from the PUBLISHED @schedjs/daemon npm
# package (the artifact that passed the suite/parity gates), NOT from monorepo
# sources. Storage adapters are composed at the image level (docs
# 13.self-hosting): FROM schedd:vX + RUN yarn add @schedjs/storage-mongo.
#
# Build:
#   docker build -t schedd:0.12.1 apps/daemon
#
# Private-registry mirror (optional, internal use): pass the registry URL as
# NPM_REGISTRY + a BuildKit secret to install from a mirror instead of npmjs.
#
# The token is passed as a BuildKit secret (never an ARG/ENV → not in image
# layers or history) and used only during install; the final image carries no
# credentials. A derived image that composes adapters on top must supply its
# own registry block (recipe in docs 13.self-hosting).

ARG DAEMON_VERSION=0.12.1
FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production

# ARG scope: values declared before FROM are not visible inside the stage —
# re-declare (the default carries over from the global ARG above).
ARG DAEMON_VERSION

# Private-registry override for our internal build. Public builds omit this
# and install from the public npm registry.
ARG NPM_REGISTRY=""

# Minimal project so yarn works outside a monorepo; node-modules linker so a
# later `yarn add @schedjs/storage-*` (composition) lands in the SAME
# node_modules and `schedd` resolves from .bin. CI=1 disables yarn's
# interactive prompts. npmMinimalAgeGate: 0 — yarn 4.18 quarantines packages
# whose publish-time metadata is missing (a mirror serves none); the gate is
# a supply-chain nicety we can't satisfy against a private registry.
# The optional token comes from the BuildKit secret (mount type=secret).
# docker-cli: the docker runner spawns `docker run --rm` (books T2 finding
# 2026-08-22) — the official image ships the CLI; the operator still mounts
# the docker socket / DOCKER_HOST (docs 06.runners/02.docker).
RUN --mount=type=secret,id=npm_token echo '{"name":"schedd","private":true,"packageManager":"yarn@4.18.0"}' > package.json \
 && corepack enable \
 && apk add --no-cache docker-cli \
 && { [ -n "$NPM_REGISTRY" ] \
      && { printf 'nodeLinker: node-modules\nnpmMinimalAgeGate: 0\nnpmRegistryServer: "%s"\nnpmAlwaysAuth: true\nnpmAuthToken: "%s"\n' "$NPM_REGISTRY" "$(cat /run/secrets/npm_token)" > .yarnrc.yml; } \
      || printf 'nodeLinker: node-modules\nnpmMinimalAgeGate: 0\n' > .yarnrc.yml; } \
 && CI=1 yarn add @schedjs/daemon@${DAEMON_VERSION} \
 && rm -f .yarnrc.yml \
 && yarn cache clean

ENV PATH="/app/node_modules/.bin:${PATH}"
EXPOSE 8080
VOLUME ["/data"]
ENTRYPOINT ["schedd"]
