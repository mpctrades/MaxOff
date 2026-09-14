FROM node:22-alpine
RUN apk add --no-cache openssl

EXPOSE 3000

WORKDIR /app

ENV NODE_ENV=production

# React Router bakes the allowed action origin into the server build. Shopify
# posts embedded-app actions from this public HTTPS origin while the container
# receives plain HTTP, so the production URL must exist at build time as well
# as at runtime (see react-router.config.ts).
ARG SHOPIFY_APP_URL
ENV SHOPIFY_APP_URL=${SHOPIFY_APP_URL}

COPY package.json package-lock.json* ./

RUN npm ci --omit=dev && npm cache clean --force

COPY . .

RUN npm run build

CMD ["npm", "run", "docker-start"]
