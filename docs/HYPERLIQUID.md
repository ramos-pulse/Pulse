# Passage du bot perps sur Hyperliquid

Préparé sur la branche `hyperliquid`, **pas encore installé**. Rien ne change tant que le secret `PERPS_VENUE` ne vaut pas `hyperliquid`.

## Ce qui change

- **Plus de marchés** : chaque jour, le bot choisit les 12 perps les plus échangés sur Hyperliquid (toujours BTC, ETH, SOL, plus les autres selon le volume du jour). Le chercheur les étudie tous, et le pilote surveille jusqu'à 8 marchés à la fois (les positions restent limitées par « positions max »).
- **Frais plus bas** : 0,045 % par côté au lieu de 0,06 %, et pas de frais d'emprunt (un « funding » horaire, payé ou reçu, à la place).
- **Petites positions possibles** : minimum 10 $ de *taille* (et non 10 $ de collatéral).
- **Stops posés chez Hyperliquid** : le stop est un vrai ordre sur la plateforme, déplacé quand le stop suiveur monte. La position reste protégée même si le serveur tombe.
- **Marge isolée** : chaque position a sa propre marge ; une liquidation ne toucherait qu'elle. Le levier reste plafonné pour que la liquidation soit au moins 3 fois plus loin que le stop.
- **Mise selon la confiance** (aussi pour le bot spot et la version Jupiter) : ×0,5 à ×1,5 selon le score de la stratégie, toujours sous le plafond de risque.

## Sécurité

Le bot signe avec un **portefeuille API** (agent) : il peut ouvrir et fermer des positions, **pas retirer ni transférer d'argent** (règle imposée par Hyperliquid). La clé de ton compte principal ne quitte jamais ton téléphone.

## Installation (le jour où tu dis « go »)

1. **Compte Hyperliquid** : va sur app.hyperliquid.xyz, connecte un portefeuille EVM (MetaMask, Rabby, ou ton portefeuille habituel s'il gère Arbitrum).
2. **Transférer les USDC** : sur Hyperliquid, « Deposit ». Si Solana est proposé, envoie tes USDC depuis le portefeuille perps actuel. Sinon, passe par un pont (Across, deBridge, Mayan) vers ton compte Hyperliquid, ou par Arbitrum. Minimum 5 USDC. Garde les USDC côté **Perps**.
3. **Portefeuille API** : app.hyperliquid.xyz/API → « Generate », nomme-le `Pulse`, durée de validité **maximale**, puis « Authorize » et signe avec ton portefeuille. Copie la **clé privée de l'agent** (affichée une seule fois).
4. **Secrets Supabase** (Edge Functions → Secrets), à ajouter toi-même, jamais dans le chat :
   - `HL_ACCOUNT_ADDRESS` : l'adresse de ton compte principal Hyperliquid (0x…)
   - `HL_AGENT_PRIVATE_KEY` : la clé privée du portefeuille API
5. **Bots en pause**, puis « go » : je fusionne la branche, je déploie, puis j'ajoute `PERPS_VENUE = hyperliquid`.
6. Au premier tick, le bot remet son point de départ à la valeur du compte Hyperliquid (le transfert n'est ni un gain ni une perte).

## Vérifié

- Signature : les 7 vecteurs de test officiels du SDK Hyperliquid (keccak, secp256k1, msgpack, EIP-712).
- Simulation complète contre un faux serveur Hyperliquid : ouverture, stop posé, stop suiveur déplacé, stop déclenché avec le vrai résultat, dépôt, short, stop refusé (position refermée aussitôt), serveur injoignable, secrets absents, passage Jupiter → Hyperliquid.

## À savoir

- L'agent a une date d'expiration choisie à sa création : prends la plus longue. S'il expire, le bot ne peut plus trader (alerte sur le téléphone), les stops déjà posés restent en place.
- Le résultat affiché d'un trade n'inclut pas le funding horaire, qui s'ajoute ou se retire du compte à part.
- Les marchés de moins de ~35 jours d'historique en 15 min ne sont pas étudiés par le chercheur (historique insuffisant).
