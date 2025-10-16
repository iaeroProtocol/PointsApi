FROM node:20-alpine
RUN apk add --no-cache tini
WORKDIR /app

# copy manifests first
COPY apps/points-indexer/package.json ./
COPY apps/points-indexer/package-lock.json ./

# TEMP: include dev deps so tsx is present (see note #2)
RUN npm ci

# copy source
COPY apps/points-indexer/ ./

ENV NODE_ENV=production
ENV HEALTH_PORT=8090
EXPOSE 8090

ENTRYPOINT ["/sbin/tini","--"]
CMD ["npm","start"]
