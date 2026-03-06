# Utilisation d'une version légère de Node.js
FROM node:20-alpine

# Définition du répertoire de travail
WORKDIR /usr/src/app

# Copie des fichiers de définition des dépendances
# On le fait avant de copier le reste pour profiter du cache Docker
COPY package.json yarn.lock ./

# Installation des dépendances
RUN yarn install --frozen-lockfile

# Copie du reste du code source
COPY . .

# Commande par défaut : lance les tests
CMD ["node", "index.js"]