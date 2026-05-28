FROM node:20-alpine

# Dépendances pour better-sqlite3 (compilation native)
RUN apk add --no-cache python3 make g++ curl

WORKDIR /app

COPY package.json ./
RUN npm install --production

COPY server.js ./
COPY public/ ./public/

# Dossier persistant pour la BDD SQLite
RUN mkdir -p /data

EXPOSE 3000

CMD ["node", "server.js"]
