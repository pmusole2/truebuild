# Build from the repository root: docker build -f api/Dockerfile .
FROM node:24-bookworm-slim
WORKDIR /app

COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/contracts/package.json ./packages/contracts/package.json
COPY api/package.json ./api/package.json
COPY app/package.json ./app/package.json
RUN npm ci --omit=dev --workspace @truebuild/api --ignore-scripts

COPY packages/contracts/src ./packages/contracts/src
COPY api/src ./api/src
COPY api/tsconfig.json ./api/tsconfig.json

# tsx is an installed production dependency; workspace contracts also contain TypeScript.
# The app sends frozen images, not clips; ffmpeg is not needed by its reachable flows.
# Sevalla supplies PORT at runtime; the server's local fallback is 3001.
ENV NODE_ENV=production PROVIDER_MODE=meta
USER node
EXPOSE 3001
CMD ["npm", "run", "start", "--workspace", "@truebuild/api"]
