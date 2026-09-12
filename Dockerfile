FROM node:22-bookworm-slim AS build

WORKDIR /src
COPY package.json package-lock.json ./
COPY packages ./packages

RUN npm ci --ignore-scripts
RUN mkdir -p plugins/contextos/server
RUN npm run plugin:build

FROM node:22-bookworm-slim

LABEL io.modelcontextprotocol.server.name="io.github.yubinbin32-ops/contextos"
LABEL org.opencontainers.image.source="https://github.com/yubinbin32-ops/ContextOS"
LABEL org.opencontainers.image.description="Context OS for AI coding agents: task-scoped context, AST code streams, verified mutation, and rollback."

WORKDIR /workspace
COPY --from=build /src/plugins/contextos/server/contextos-mcp.mjs /opt/contextos/contextos-mcp.mjs

ENV CONTEXTOS_PROJECT_ROOT=/workspace

ENTRYPOINT ["node", "/opt/contextos/contextos-mcp.mjs"]
