FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:20-alpine AS production
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist
COPY migrations ./migrations
EXPOSE 8080
ENV PORT=8080 NODE_ENV=production
CMD ["node", "dist/server.js"]

FROM builder AS test
CMD ["npx", "vitest", "run"]
