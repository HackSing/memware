# memware kernel service — stateless extract / embed / search over HTTP.
#
# Build:  docker build -t memware-kernel .
# Run:    docker run --rm -p 18971:18971 \
#           -e MEMWARE_KERNEL_TOKEN=<32+ hex chars> \
#           -e MEMWARE_API_KEY=<OpenAI-compatible key> memware-kernel
#
# The image contains no memory data and no credentials: everything is injected
# through the environment at run time (see docs/architecture.md).

# ── Stage 1: compile a self-contained binary ─────────────────
FROM oven/bun:1 AS build
WORKDIR /src

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY tsconfig.json ./
COPY src ./src

RUN bun build --compile --target=bun-linux-x64 src/kernel/main.ts --outfile /out/memware-kernel

# ── Stage 2: minimal runtime ─────────────────────────────────
FROM debian:bookworm-slim AS runtime

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --system --create-home --uid 10001 memware

WORKDIR /app
COPY --from=build /out/memware-kernel /app/memware-kernel
RUN chmod 0555 /app/memware-kernel

USER memware

# Listen on every interface inside the container; the Bearer token is still
# mandatory, so an exposed port is never an unauthenticated surface.
ENV MEMWARE_KERNEL_HOST=0.0.0.0
ENV MEMWARE_KERNEL_PORT=18971
EXPOSE 18971

ENTRYPOINT ["/app/memware-kernel"]
