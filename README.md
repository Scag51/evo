# EVO Dashboard · Equinoxes

Dashboard interne de suivi des contrats EVO clients, connecté à l'API Axonaut.

## Stack

- **Node.js** (natif, zéro dépendance npm)
- **Docker** (Alpine)
- Déployé via **Coolify** sur VPS Debian

## Déploiement Coolify

### 1. Créer une nouvelle application

- Coolify → **New Resource** → **Public Repository** (ou Private avec deploy key)
- URL du repo GitHub : `https://github.com/VOTRE_ORG/evo-dashboard`
- Build Pack : **Dockerfile**

### 2. Variable d'environnement

Dans Coolify → votre app → **Environment Variables** :

| Variable | Valeur |
|---|---|
| `AXONAUT_API_KEY` | Votre clé API Axonaut |
| `PORT` | `3000` (déjà par défaut) |

⚠️ Ne jamais mettre la clé dans le code ou dans le repo Git.

### 3. Domaine

- Coolify → **Domains** → ajouter ex: `evo.equinoxes.fr`
- HTTPS géré automatiquement par Coolify (Let's Encrypt)

### 4. Deploy

Cliquer **Deploy** — ou pousser un commit sur `main` si le webhook GitHub est configuré.

## Développement local

```bash
AXONAUT_API_KEY=votre_cle node server.js
# Ouvrir http://localhost:3000
```

## Structure

```
├── Dockerfile          # Image Docker Alpine Node 20
├── server.js           # Serveur HTTP : proxy API + fichiers statiques
├── public/
│   └── index.html      # Dashboard HTML (Chart.js, fonts Google)
└── package.json
```
