# Envoi automatique des factures - Paul Beuscher

Chaque soir à **21h (heure de Paris)**, GitHub Actions lance ce script qui :

1. récupère les **commandes du jour passées via Shopify POS** ;
2. garde celles qui ont un **email client** (sinon → ignorée) ;
3. génère une **facture PDF** (format Paul Beuscher + TVA) ;
4. l'envoie par **email via Brevo** ;
5. **tague** la commande `facture-envoyee` → jamais de doublon.

> ✅ Aucun serveur à héberger : tout tourne gratuitement sur GitHub Actions + Brevo.

---

## Installation (à faire une seule fois)

### 1. Mettre le code sur GitHub
Crée un repo (ex. `shopify-factures-auto`) dans l'organisation **Regard-Beauty-MG** et pousse ces fichiers :

```bash
cd shopify-factures-auto
git init
git add .
git commit -m "Envoi automatique des factures"
git branch -M main
git remote add origin https://github.com/Regard-Beauty-MG/shopify-factures-auto.git
git push -u origin main
```

### 2. Créer le token Shopify (custom app)
Dans **Shopify Admin → Settings → Apps and sales channels → Develop apps → Create an app** :
- Donne un nom (ex. `Factures auto`).
- **Configure Admin API scopes** → coche :
  - `read_orders`
  - `write_orders` (nécessaire pour poser le tag)
- **Install app** → copie le **Admin API access token** (commence par `shpat_...`).
- Note aussi ton domaine `.myshopify.com` (ex. `paul-beuscher-2.myshopify.com`).

### 3. Créer le compte Brevo (envoi email gratuit)
- Crée un compte sur **brevo.com** (300 emails/jour gratuits).
- **Senders & IP → Senders** : ajoute et **vérifie** l'adresse expéditrice (ex. `dev@regardbeauty.com`).
- **SMTP & API → API Keys** : crée une clé API (commence par `xkeysib-...`).

### 4. Ajouter les Secrets dans GitHub
Repo → **Settings → Secrets and variables → Actions → New repository secret**. Crée :

| Nom | Valeur |
|-----|--------|
| `SHOP` | `paul-beuscher-2.myshopify.com` |
| `SHOPIFY_TOKEN` | le token `shpat_...` |
| `BREVO_API_KEY` | la clé `xkeysib-...` |
| `SENDER_EMAIL` | `dev@regardbeauty.com` (vérifiée dans Brevo) |
| `SENDER_NAME` | `Paul Beuscher` |

### 5. Tester
Repo → onglet **Actions → "Envoi factures du jour" → Run workflow**.
Regarde les logs : tu verras combien de factures ont été envoyées / ignorées.

---

## Tester en local (optionnel)
```bash
npm install
cp .env.example .env   # remplis tes vraies valeurs
# Test SANS rien envoyer :
DRY_RUN=1 node --env-file=.env envoi-factures.js
# Envoi réel :
node --env-file=.env envoi-factures.js
```

---

## Bon à savoir
- **Filtre POS** : seules les commandes `source_name:pos` (vente en magasin) sont traitées ; les commandes en ligne sont ignorées.
- **Clients sans email** (la plupart des ventes POS « No customer ») → automatiquement ignorés.
- **Pas de doublon** : une commande déjà taguée `facture-envoyee` n'est jamais renvoyée.
- **Heure** : le job se déclenche à 19h et 20h UTC pour couvrir l'heure d'été/hiver ; le script ne traite réellement qu'à **21h Paris**.
- **En cas d'erreur** d'envoi, le job GitHub apparaît en rouge → tu es prévenu par email GitHub.
- **Personnaliser la facture** : modifie la fonction `genererFacturePDF` dans `envoi-factures.js` (logo, mentions légales, SIRET, etc.).
