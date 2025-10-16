# --- deps
FROM node:20-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci

# --- build
FROM node:20-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# --- run
FROM node:20-alpine AS runner
WORKDIR /app
RUN apk add --no-cache tini
ENV NODE_ENV=production

# optional: if you expose a health port from the indexer
ENV HEALTH_PORT=8090
EXPOSE 8090

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package*.json ./

ENTRYPOINT ["/sbin/tini","--"]
CMD ["node","dist/indexer.js"]
