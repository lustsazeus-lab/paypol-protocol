# ═══════════════════════════════════════════════════════════
# PayPol Daemon — ZK Proof Generator & Escrow Settlement
# Generates real ZK-SNARK proofs (Circom V2 + snarkjs)
# and calls ShieldVaultV2.executeShieldedPayout() on-chain
# ═══════════════════════════════════════════════════════════

FROM node:20-alpine AS base
RUN apk add --no-cache libc6-compat python3 make g++

WORKDIR /app

# Copy package files and install dependencies
COPY package.json package-lock.json* ./
RUN npm ci --force 2>/dev/null || npm install --force

# Copy Prisma schema and generate client
COPY prisma ./prisma/
RUN npx prisma generate

# Copy daemon source
COPY daemon.ts ./
COPY prisma.config.ts ./

# Copy ZK circuit artifacts (wasm + zkey) into container
# These are the compiled Circom V2 circuits for proof generation
COPY circuits/ ./circuits/

# Use tsx for TypeScript execution
RUN npm install -g tsx

EXPOSE 3002

CMD ["tsx", "daemon.ts"]
