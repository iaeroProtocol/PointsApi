# --- deps
FROM node:20-alpine AS deps
WORKDIR /app
# copy manifests first for better caching
COPY package*.json ./
RUN npm ci

# --- build
FROM node:20-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
# copy the app source
COPY . .
# build TS -> dist
RUN npm run build

# --- run
FROM node:20-alpine AS runner
WORKDIR /app
RUN apk add --no-cache tini
ENV NODE_ENV=production
# only what we need at runtime
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package*.json ./

# Railway provides $PORT; default to 8080 locally
ENV PORT=8080
EXPOSE 8080

ENTRYPOINT ["/sbin/tini","--"]
CMD ["node","dist/server.js"]
