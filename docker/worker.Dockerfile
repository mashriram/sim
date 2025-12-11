FROM oven/bun:1.2.13 AS base

WORKDIR /app

# Copy package files
COPY package.json bun.lock turbo.json ./
COPY apps/sim/package.json ./apps/sim/package.json
# Add other package.json files if needed

# Install dependencies
RUN bun install

# Copy source code
COPY . .

# Build the worker (if needed, or just run ts-node/bun)
# For bun, we can run TS directly.

WORKDIR /app/apps/sim

CMD ["bun", "run", "worker.ts"]
