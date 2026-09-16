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

# Generate the Prisma Client into the image, not on every container start.
# `npm ci` above runs Prisma's postinstall before the schema is copied, so the
# client cannot be generated there — which is why this used to run at boot and
# cost ~1.7s of downtime on every deploy, for 136ms of actual work. It belongs
# here: the schema is present, and the result is baked into the layer.
#
# `prisma migrate deploy` deliberately stays at runtime (npm run setup). That
# one talks to the live database and must run against it, not against the build.
RUN npx prisma generate

RUN npm run build

CMD ["npm", "run", "docker-start"]
