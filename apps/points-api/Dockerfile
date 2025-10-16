FROM node:20-alpine
RUN apk add --no-cache tini
WORKDIR /app

COPY apps/points-api/package.json ./
COPY apps/points-api/package-lock.json ./

# TEMP: include dev deps so tsx is present (see note #2)
RUN npm ci

COPY apps/points-api/ ./

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

ENTRYPOINT ["/sbin/tini","--"]
CMD ["npm","start"]
