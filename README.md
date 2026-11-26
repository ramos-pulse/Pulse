# Pulse : deux bots Solana, sans serveur à gérer

Comme ton app Lovable, mais à toi : les bots tournent sur **Supabase** (gratuit), l'app s'ouvre sur ton téléphone depuis **GitHub Pages** (gratuit). Ta seule clé externe, c'est **Helius**.

| Bot | Marché | Fonctionnement |
|---|---|---|
| Bot 1 · Spot | USDC ⇄ SOL, JUP, BONK, WBTC, WETH (Jupiter) | Achète la crypto la plus forte quand elle casse son plus haut en tendance |
| Bot 2 · Perps | SOL sur Jupiter Perps, long ou short | Même stratégie dans les deux sens, levier x3 max |

Le cron de Supabase appelle la fonction `pulse` chaque minute (comme Lovable). L'app parle à cette même fonction.

---

## Mise en place depuis ton téléphone (environ 20 minutes)

### 1. Supabase : créer le projet
1. Va sur **supabase.com** → Start your project → crée un compte (gratuit).
2. **New project** : nom `pulse`, région **Europe (Frankfurt)**, choisis un **mot de passe de base de données** et note-le.
3. Note l'**identifiant du projet** : c'est la suite de lettres dans l'adresse `supabase.com/dashboard/project/XXXXXXXX`.
4. Crée un **jeton d'accès** : icône de ton compte → **Access Tokens** → Generate new token → note-le.

### 2. Supabase : les secrets des bots
Dans ton projet : **Edge Functions → Secrets** (ou Project Settings → Edge Functions). Ajoute :

| Nom | Valeur |
|---|---|
| `DASHBOARD_TOKEN` | un mot de passe long, que toi seul connais (pour ouvrir l'app) |
| `BOT_WALLET_PRIVATE_KEY` | clé privée d'un compte Phantom **dédié** au bot spot |
| `PERPS_WALLET_PRIVATE_KEY` | clé privée d'un **autre** compte Phantom dédié au bot perps |
| `SOLANA_RPC_URL` | ton lien Helius (`https://mainnet.helius-rpc.com/?api-key=...`) |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | facultatif : notifications même téléphone verrouillé |

Phantom → Paramètres → Gérer les comptes → le compte → **Afficher la clé privée**. N'utilise jamais ton wallet principal.

### 3. GitHub : le dépôt
1. Crée un compte sur **github.com** si besoin.
2. **New repository** → nom `pulse` → **Public** (GitHub Pages gratuit l'exige ; le code ne contient aucun secret) → Create.
3. Le code y est envoyé (par Claude, ou en important ce dossier).

### 4. GitHub : les clés de déploiement
Dépôt → **Settings → Secrets and variables → Actions → New repository secret** :

| Nom | Valeur |
|---|---|
| `SUPABASE_ACCESS_TOKEN` | le jeton de l'étape 1.4 |
| `SUPABASE_PROJECT_REF` | l'identifiant du projet (étape 1.3) |
| `SUPABASE_DB_PASSWORD` | le mot de passe de base de données (étape 1.2) |

### 5. GitHub : activer l'app
Dépôt → **Settings → Pages** → Source : **GitHub Actions**.

### 6. Lancer le déploiement
Dépôt → onglet **Actions** → **Déployer Pulse** → **Run workflow**. Deux coches vertes = tout est en ligne (tables, cron, fonction, app).

### 7. Ouvrir l'app
1. Dans Brave : `https://TON-PSEUDO-GITHUB.github.io/pulse/`
2. Entre l'identifiant de ton projet Supabase et ton `DASHBOARD_TOKEN`.
3. À la première ouverture, l'app installe toute seule le tick chaque minute (Réglages → « Tick automatique » coché).
4. Menu ⋮ → **Ajouter à l'écran d'accueil**.

### 8. Avant de mettre de l'argent
1. Onglet **Backtest** → Lancer : la stratégie rejouée sur les 60 derniers jours, frais inclus.
2. Dépose des **USDC (réseau Solana)** + environ **0,03 SOL** sur chaque compte (au moins 10 $ d'USDC pour le perps).
3. **Lancer la mission**, objectif et échéance au choix.

---

## La stratégie (résumé)
- Bougies 1 h, entrée seulement en tendance forte sur cassure du plus haut (ou plus bas) des 24-72 h.
- Stop initial à 2 ATR, puis stop suiveur : pas de take profit fixe, les gains courent.
- Risque 1,5 % du capital par trade (0,5 à 2 % selon la forme), perte max 5 % par jour.
- Le bot apprend chaque jour (3 réglages testés sur 60 jours), met de côté un marché qui perd, attend quand rien n'est rentable.
- Chaque transaction est confirmée sur la blockchain avant d'être enregistrée ; PnL réel, frais inclus.
- **Pause** = plus d'entrée, mais la position en cours reste gérée. **Arrêt d'urgence** = tout est revendu/fermé.

## À savoir
- Supabase gratuit : 2 s de calcul par appel. Le bot est conçu pour rester dessous (backtest découpé marché par marché).
- Un projet Supabase gratuit peut être mis en pause par Supabase en cas d'inactivité prolongée. Le tick chaque minute fait travailler la base, mais vérifie de temps en temps que « Dernier contrôle » est à jour dans l'app.
- Historique des prix : API publique Coinbase. Un marché absent (ex. JUP) est simplement ignoré.
- Aucune stratégie ne gagne à coup sûr. Ne mets que ce que tu acceptes de perdre. Ceci n'est pas un conseil financier.

## Structure
```
supabase/functions/pulse/index.ts     la fonction : tick (cron) + API de l'app
supabase/functions/pulse/store.ts     base de données, verrou anti-chevauchement, notifications
supabase/functions/pulse/engine/      stratégie, cerveau, Solana, Jupiter, bougies, bots spot et perps
supabase/migrations/                  tables + installation du cron
web/                                  l'app mobile (GitHub Pages)
.github/workflows/deploy.yml          déploiement automatique
tests/                                npm test (Node 22)
```
