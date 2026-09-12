FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends fonts-dejavu-core && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production DATABASE_PATH=/app/data/tradefinder.sqlite HEALTH_PORT=8080
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# The card renderer and the application emojis read these at runtime; without them the bot starts but loses its icons.
COPY assets ./assets
COPY package.json ./
RUN mkdir /app/data && chown node:node /app/data
USER node
EXPOSE 8080
# The platform restarts the container if the gateway drops or scans stop finishing, rather than leaving it idling.
HEALTHCHECK --interval=60s --timeout=5s --start-period=45s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.HEALTH_PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/src/index.js"]
