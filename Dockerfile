FROM node:22-bookworm-slim AS base

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package.json ./

RUN npm install

COPY . .

EXPOSE 3050

# Default CMD is overwritten by docker-compose (start:dev).
CMD ["npm", "run", "start:dev"]
