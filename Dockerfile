FROM node:20-alpine

WORKDIR /app

# Copie des fichiers
COPY package.json ./
COPY server.js ./
COPY public/ ./public/

# Pas de npm install — aucune dépendance externe
# Node.js natif uniquement

EXPOSE 3000

CMD ["node", "server.js"]
