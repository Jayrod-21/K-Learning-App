# node:22-alpine (current LTS): Node 20 reached EOL 2026-04-30. F-085 aligns
# this dev image with the client prod build stage (Dockerfile.prod), the
# server (server/Dockerfile), and CI (.github/workflows/ci.yml) on one major.
FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

EXPOSE 4173

CMD ["npx", "vite", "--host", "0.0.0.0", "--port", "4173"]
