// Serveur uniquement : BOT 2 sur HYPERLIQUID — perps long ET short sur les marchés les plus échangés.
// Même cerveau que la version Jupiter (stratégies du chercheur, stop suiveur, risque plafonné), avec trois différences :
//  - les ordres sont exécutés immédiatement (pas d'attente de « keepers ») ;
//  - le stop est posé CHEZ Hyperliquid (ordre déclencheur) et déplacé quand le stop suiveur monte : la position reste
//    protégée même si le serveur tombe ;
//  - minimum 10 $ de TAILLE (et non 10 $ de collatéral) : plusieurs petites positions possibles avec peu de capital.
// Marge ISOLÉE : chaque position a sa propre marge ; levier plafonné pour que la liquidation reste 3 fois plus loin que le stop.
import { liveRegimeOf, regimeFitLabel } from "./math.ts";
import { hlMakerEntry } from "./hyperliquid.ts";
import type { BotState, Store } from "../store.ts";
import { isBenched, learn, mindset, newBrain, riskPerTrade } from "./brain.ts";
import { candles as getCandles, lastClosedCandle } from "./candles.ts";
import { fundingHistory } from "./funding.ts";
import {
  hlAccount, hlAsset, hlCancel, hlCredentials, hlFills, hlMarketOrder, hlMids, hlOpenOrders, hlPlaceStop, hlSetLeverage, hlTransfers, HL_RULES,
  type HlAccount, type HlAsset, type HlPosition,
} from "./hyperliquid.ts";
import { isSetup, setupExit, setupSignal, trailParams, TRAILING, type Extra, type SetupParams, extendOnTime, EDGE, expectedMove } from "./setups.ts";
import { addToVault, applyTransfer, AGGR_AGGRESSIVE, AGGR_LEVELS, atr, conviction, cooldownMs, DEFAULT_PARAMS, effectiveAggr, exitCheck, EXTRA_SOFT, floorOf, LIQ, loadMemory, loadPerpsConfig, migratePositions, missionEnd, PARTIAL, pruneSignal, perpsChange, perpsMarkets, PRESETS, riskFactor, riskGate, RULES, sampleCurve, sideMult, TOTAL_RISK, tradable, trailStop, trendSignal, volScale, type Interval, type Memory, type Params, type PerpsConfig, type PerpsPlan, type Position, lossPause, stopProtects } from "./strategy.ts";

type Admin = Store;
type PerpsRow = BotState;
const FLOOR_USD = 5;

// ---------------------------------------------------------------------------------------------------
// Règles de taille propres à Hyperliquid (testées dans tests/perpsHl.test.ts)
// ---------------------------------------------------------------------------------------------------
/** Levier sans risque de liquidation avant le stop : marge de maintien Hyperliquid = moitié de la marge initiale au levier max. */
export function hlSafeLeverage(dist: number, maxLeverage: number): number {
  const maintenance = 1 / (2 * Math.max(1, maxLeverage));
  return 1 / (dist / LIQ.safety + maintenance + 2 * HL_RULES.takerFee + HL_RULES.fundingBuffer);
}

/**
 * Taille d'une position : risque voulu → taille (USD) = capital × risque / (distance du stop + frais + glissement).
 * Levier ADAPTÉ AU STOP (28/11) : le plus haut levier du marché qui garde la liquidation 3 fois plus loin que le stop.
 * Le levier ne change pas la perte au stop (fixée par la taille) : il réduit seulement la marge bloquée, pour laisser
 * de la place aux autres positions. Garde-fous : frais et glissement comptés dans le risque, taille ≤ 10 × le capital.
 * Hyperliquid exige 10 $ de taille : on monte à 10 $ seulement si le risque reste sous le plafond.
 * La marge (taille / levier) doit tenir dans les USDC disponibles.
 */
export function hlSizing(equity: number, available: number, price: number, stop: number, risk: number, maxLev: number, maxRisk: number) {
  const dist = Math.abs(price - stop) / price;
  if (!(dist > 0) || !(equity > 0) || !(price > 0)) return null;
  const loss = dist + 2 * HL_RULES.takerFee + HL_RULES.expectedSlip; // perte réelle au stop, pour 1 $ de taille
  const lev = Math.max(1, Math.min(maxLev, Math.floor(hlSafeLeverage(dist, maxLev))));
  let notional = Math.min((equity * risk) / loss, equity * HL_RULES.maxExposure);
  if (notional < HL_RULES.minNotionalUsd) {
    if ((HL_RULES.minNotionalUsd * loss) / equity > maxRisk + 1e-9 || equity * HL_RULES.maxExposure < HL_RULES.minNotionalUsd * 1.02) return null;
    notional = HL_RULES.minNotionalUsd * 1.02; // petite marge : l'arrondi de la taille ne doit pas repasser sous 10 $
  }
  const margin = notional / lev;
  if (margin > available * 0.95) { notional = available * 0.95 * lev; if (notional < HL_RULES.minNotionalUsd * 1.02) return null; }
  return { notional, margin: notional / lev, leverage: lev, coins: notional / price, risk: (notional * loss) / equity };
}

/**
 * Stop de secours d'une position reprise sans mémoire : ±4 %, mais toujours au tiers de la distance de liquidation
 * (avec le levier adapté au stop, une position à x25 serait liquidée vers −2 %, avant un stop à −4 %).
 */
export function resumeStopDist(o: { entryPx: number; liqPx: number | null; leverage: number }): number {
  const liq = o.liqPx && o.liqPx > 0 ? Math.abs(o.entryPx - o.liqPx) / o.entryPx : 1 / Math.max(1, o.leverage) / 2;
  return Math.max(0.001, Math.min(0.04, liq / 3));
}

/** Perte si le stop de chaque position est touché, en part du capital. */
/**
 * Perte si le stop de chaque position est touché, en part du capital, MESURÉE DEPUIS LE PRIX D'ENTRÉE (28/11) :
 * avant, elle partait du prix actuel, si bien qu'une position gagnante (stop resté loin) semblait de plus en plus risquée
 * et bloquait toute nouvelle entrée. Un gain rendu n'est pas une perte du capital engagé. Frais et glissement compris.
 */
export function openRisk(positions: Position[], valueUsd: number) {
  if (!(valueUsd > 0)) return 0;
  return positions.reduce((s, p) => {
    const entry = p.entry ?? p.live?.price ?? 0, stop = p.stop ?? entry;
    if (!(entry > 0)) return s;
    const notional = p.coinSize ? p.coinSize * entry : (p.sizeUsd ?? 0);
    const adverse = p.side === "long" ? entry - stop : stop - entry;
    return s + Math.max(0, adverse / entry + 2 * HL_RULES.takerFee + HL_RULES.expectedSlip) * notional;
  }, 0) / valueUsd;
}

export async function getHlAddress(): Promise<string | null> {
  try { return hlCredentials().account; } catch { return null; }
}
export async function currentHlValue() {
  const { account } = hlCredentials();
  const a = await hlAccount(account);
  return { address: account, valueUsd: a.valueUsd, positions: a.positions };
}

/** Résultat réel d'une fermeture : gains réalisés moins frais, d'après les exécutions Hyperliquid depuis l'ouverture. */
/** Coût par côté compté par le chercheur pour Hyperliquid (frais + glissement) : sert au filtre « ça vaut les frais ». */
export const HL_RESEARCH_FEE = 0.0007;

export async function realizedPnl(account: string, coin: string, since: number, opts: { tries?: number; waitMs?: number } = {}): Promise<number | null> {
  const tries = opts.tries ?? 4, waitMs = opts.waitMs ?? 2_000;
  for (let i = 0; i < tries; i++) {
    if (i) await new Promise((r) => setTimeout(r, waitMs));
    const fills = await hlFills(account, Math.max(0, since - 60_000)).catch(() => null);
    if (!fills) continue;
    // 28/11 (bug XMR) : on part de la PREMIÈRE exécution d'ouverture de cette position. Avant, tout ce qui précédait l'ouverture
    // d'une minute était compté : la fermeture d'une position précédente sur le même marché était comptée une seconde fois.
    const mine = fills.filter((f) => f.coin === coin).sort((a, b) => a.time - b.time);
    const open = mine.find((f) => /^Open/.test(f.dir) && f.time >= since - 60_000);
    if (!open) continue;
    const after = mine.filter((f) => f.time >= open.time);
    // 28/11 : les exécutions arrivent avec du retard chez Hyperliquid. Juste après notre ordre de fermeture, la fermeture peut
    // manquer : le trade serait noté « −0,02 $ » (frais d'ouverture seuls). On attend que tout ce qui a été ouvert soit fermé.
    const openSz = after.filter((f) => /^Open/.test(f.dir)).reduce((s, f) => s + f.sz, 0);
    const closeSz = after.filter((f) => /^Close/.test(f.dir)).reduce((s, f) => s + f.sz, 0);
    if (closeSz < openSz * 0.99) continue;
    return after.reduce((s, f) => s + f.closedPnl - f.fee, 0); // frais d'ouverture inclus (closedPnl = 0 à l'ouverture)
  }
  return null; // illisible : résultat estimé à partir de la valeur de la position
}

/** Pose (ou déplace) le stop chez Hyperliquid : le nouveau d'abord, l'ancien annulé ensuite (jamais sans stop). */
async function syncStop(key: string, asset: HlAsset, p: Position, real: HlPosition): Promise<string | null> {
  if (p.stop == null) return null;
  const moved = p.stopPx == null || Math.abs(p.stop - p.stopPx) / p.stop > 0.001 || Math.abs((p.coinSize ?? 0) - real.size) / real.size > 0.001;
  if (p.stopOid && !moved) return null;
  const oid = await hlPlaceStop(key, asset, p.side, real.size, p.stop);
  const old = p.stopOid;
  p.stopOid = oid; p.stopPx = p.stop; p.coinSize = real.size;
  if (old && old !== oid) await hlCancel(key, asset, old).catch(() => null); // un ancien stop resté en place ne peut que réduire la position (« reduce only »)
  return `${p.key} : stop posé chez Hyperliquid à ${fmt(p.stop)} $`;
}

export async function runHlTick(admin: Admin): Promise<string> {
  const bot = admin.bot("perps");
  const mem: Memory = loadMemory(bot.price_history);
  const mine = migratePositions(mem, bot);
  const paused = bot.status === "paused";
  if (!(bot.status === "running" || paused)) return "idle";
  const now = Date.now();
  const cfg = loadPerpsConfig(bot.config);
  const level = effectiveAggr(cfg), L = AGGR_LEVELS[level]!;
  const aggressive = level >= AGGR_AGGRESSIVE;
  const patch: Partial<PerpsRow> = {};

  // 1. Données : compte (positions réelles) et prix. Sans elles on ne touche à rien : les stops sont chez Hyperliquid.
  let creds: ReturnType<typeof hlCredentials>, acct: HlAccount, mids: Record<string, number>;
  try {
    creds = hlCredentials();
    [acct, mids] = await Promise.all([hlAccount(creds.account), hlMids()]);
  } catch (e) {
    errStreak(admin, mem, "Bot perps", (e as Error).message);
    await save(admin, mem, { last_message: `Données Hyperliquid indisponibles (${(e as Error).message.slice(0, 90)}). Les stops posés chez Hyperliquid protègent les positions.` });
    return "data_unavailable";
  }
  const prevErr = mem.errStreak ?? 0;
  mem.errStreak = 0;
  const value = acct.valueUsd;
  patch.wallet_address = creds.account;
  mem.brain = mem.brain ?? newBrain(value);
  const brain = mem.brain;
  let message = "";
  // Premier passage sur Hyperliquid : l'argent vient d'être transféré depuis Jupiter (frais de pont compris) ;
  // ce n'est ni un gain ni une perte : point de départ, courbe et perte du jour repartent de la valeur actuelle.
  if (mem.venue !== "hyperliquid") {
    mem.venue = "hyperliquid";
    if (bot.start_value_usd != null && value > 0) patch.start_value_usd = value;
    mem.curve = []; mem.dayStartValue = value; mem.lastCandleBy = {}; mem.hlLedgerAt = now; mem.lastUsdc = undefined; mem.lastSol = undefined;
    brain.equityHigh = value;
    message = `Bot perps passé sur Hyperliquid : compte de ${value.toFixed(2)} $, point de départ remis à cette valeur (ni gain ni perte).`;
  }
  const realOf = (coin: string) => acct.positions.find((p) => p.coin === coin) ?? null;
  const marketOf = (coin: string) => perpsMarkets().find((m) => m.asset === coin);

  // 2. Dépôts et retraits (registre Hyperliquid) : ni gain ni perte.
  if (mem.hlLedgerAt == null) mem.hlLedgerAt = now;
  else {
    const moves = await hlTransfers(creds.account, mem.hlLedgerAt + 1).catch(() => null);
    for (const t of moves ?? []) {
      if (bot.start_value_usd != null) patch.start_value_usd = Math.max(0.01, Number(patch.start_value_usd ?? bot.start_value_usd) + t.usd);
      applyTransfer(mem, t.usd);
      admin.addTrade("perps", { action: t.usd > 0 ? "deposit" : "withdraw", asset: "USDC", collateral_usd: Math.abs(t.usd), reason: t.kind,
        detail: { pourquoi: `${t.usd > 0 ? "Dépôt" : "Retrait"} de ${Math.abs(t.usd).toFixed(2)} $ sur Hyperliquid : point de départ, perte du jour et courbe ajustés, ce n'est ni un gain ni une perte.` } });
      message = `${t.usd > 0 ? "Dépôt" : "Retrait"} de ${Math.abs(t.usd).toFixed(2)} $ détecté : compteurs ajustés (ni gain ni perte).`;
      mem.hlLedgerAt = Math.max(mem.hlLedgerAt ?? 0, t.time);
    }
  }
  if (acct.spotUsdc > 1 && acct.withdrawable < HL_RULES.minNotionalUsd) message ||= `${acct.spotUsdc.toFixed(2)} $ d'USDC sont côté « Spot » sur Hyperliquid : transfère-les vers « Perps » pour que le bot puisse les utiliser.`;

  // 3. Réconciliation : position fermée par son stop Hyperliquid (ou liquidée), ou position trouvée sans mémoire.
  for (const p of Object.values(mine)) {
    if (realOf(p.key)) { p.missing = 0; continue; }
    p.missing = (p.missing ?? 0) + 1;
    if (p.missing < 2) continue; // une réponse vide isolée ne doit pas faire oublier une position
    const pnl = await realizedPnl(creds.account, p.key, p.openedAt ?? now - 86_400_000);
    message = recordClose(admin, mem, cfg, p.key, value, pnl, p.stopOid ? "stop_hl" : "fermee_ailleurs");
  }
  for (const o of acct.positions) {
    if (mine[o.coin]) continue;
    const d = resumeStopDist(o);
    const fallback = o.side === "long" ? o.entryPx * (1 - d) : o.entryPx * (1 + d);
    const pct = (d * 100).toFixed(1).replace(".", ",");
    mine[o.coin] = { key: o.coin, symbol: o.coin, side: o.side, entry: o.entryPx, stop: fallback, best: o.entryPx, initialRisk: Math.abs(o.entryPx - fallback), openedAt: now,
      collateralUsd: o.marginUsd, sizeUsd: o.size * o.entryPx, lastValueUsd: o.valueUsd, coinSize: o.size, source: "position trouvée sur Hyperliquid", why: `reprise d'une position existante (stop de sécurité ±${pct} %)` };
    message = `Position ${o.side} ${o.coin} trouvée : je reprends sa gestion (stop de sécurité ±${pct} %).`;
  }
  for (const p of Object.values(mine)) { const o = realOf(p.key); if (o) { p.lastValueUsd = o.valueUsd; p.sizeUsd = o.size * (mids[o.coin] ?? o.entryPx); p.collateralUsd = o.marginUsd > 0 ? o.marginUsd : p.collateralUsd; if (o.entryPx > 0) p.entry = o.entryPx; } } // 28/11 : marge et prix d'entrée réels (ex. après un doublon)
  sampleCurve(mem, value, now);

  // 4. Fin de mission (objectif, date limite, plancher).
  const end = missionEnd({ now, endAt: RULES.destroyAtDeadline && bot.end_at ? Date.parse(bot.end_at) : Infinity,
    goalUsd: Number(bot.goal_usd), valueUsd: value, floorUsd: floorOf(bot.start_value_usd, FLOOR_USD), complete: true });
  if (end && !paused) {
    const outcome = end === "success" ? "success" : end === "destroyed" ? "destroyed" : "stopped";
    await save(admin, mem, { ...patch, ...mirror(mine), last_value_usd: value });
    await liquidateHl(admin, { ...bot, ...patch, price_history: mem } as PerpsRow, outcome,
      end === "success" ? "Mission réussie ! Objectif atteint, gains sécurisés." : end === "destroyed" ? "Date limite atteinte." : `Capital sous ${floorOf(bot.start_value_usd, FLOOR_USD).toFixed(2)} $ (30 % du départ) : je protège ce qui reste.`);
    return outcome;
  }

  try {
    // 5. Positions ouvertes : stop suiveur à chaque bougie (déplacé chez Hyperliquid), sorties logicielles chaque minute.
    for (const p of Object.values(mine)) {
      const o = realOf(p.key), M = marketOf(p.key);
      if (!o) continue;
      const asset = await hlAsset(p.key);
      const price = mids[p.key] ?? o.entryPx;
      const entry = p.entry ?? o.entryPx;
      const iv: Interval = p.posInterval ?? "1h";
      const closed = lastClosedCandle(now, iv);
      const fam = p.strategy && isSetup(p.strategy) ? p.strategy : null;
      const isRangePos = !!fam && !TRAILING.includes(fam);
      const params = fam ? trailParams(p.posParams as SetupParams) : (p.posParams as Params | undefined) ?? cfg.trend ?? PRESETS[brain.preset[p.key] ?? "standard"] ?? DEFAULT_PARAMS;
      const candles = M?.candles ?? `hl:${p.key}`;
      let rangeOut: string | null = null;
      if (isRangePos && p.stopCandle !== closed) {
        const c = await getCandles(candles, iv, 260, now).catch(() => []);
        if (c.length > 40) {
          const since = p.holdSince ?? p.openedAt ?? now;
          rangeOut = setupExit(fam!, c, p.side, p.posParams as SetupParams, Math.round((now - since) / (iv === "15m" ? 900_000 : 3_600_000)), since);
          p.stopCandle = closed;
          // durée maximale atteinte mais signal toujours valable dans le même sens : on prolonge (28/11)
          if (rangeOut?.endsWith("_temps")) {
            const extra = fam === "funding" ? { funding: await fundingHistory(p.key, c[0]!.t - 86_400_000).catch(() => []) } : undefined;
            const ext = extendOnTime(rangeOut, fam!, c, p.side, sideMult(cfg.bias, "short") > 0, p.posParams as SetupParams, extra);
            if (ext) {
              p.holdSince = now; p.stop = ext.stop + (price - ext.price); if (ext.target != null) p.target = ext.target + (price - ext.price); // 28/11 : stop et objectif décalés pareil (bougies d'une autre source que le prix Hyperliquid)
              message = `${p.key} : durée maximale atteinte mais le signal est toujours valable : position prolongée (pas de frais de sortie et de re-entrée).`;
              rangeOut = null;
            }
          }
        }
      } else if (!isRangePos && p.stopCandle !== closed) {
        const c = await getCandles(candles, iv, 40, now).catch(() => []);
        if (c.length > 20) {
          const last = c.at(-1)!.c;
          p.best = p.side === "long" ? Math.max(p.best ?? entry, last) : Math.min(p.best ?? entry, last);
          p.stop = trailStop(p.side, p.stop ?? entry, p.best, atr(c, 14).at(-1)!, params);
          p.stopCandle = closed;
        }
      }
      const r = p.initialRisk ? (p.side === "long" ? price - entry : entry - price) / p.initialRisk : 0;
      if (cfg.partialTp && !isRangePos && !p.partialDone && r >= PARTIAL.atR) {
        p.stop = p.side === "long" ? Math.max(p.stop ?? entry, entry) : Math.min(p.stop ?? entry, entry);
        p.partialDone = true;
        message = `${p.key} : gain de +${String(PARTIAL.atR).replace(".", ",")} fois le risque atteint, stop remonté au prix d'entrée.`;
      }
      // le stop chez Hyperliquid suit le stop calculé ici (posé s'il manque, déplacé s'il a bougé)
      const stopNote = await syncStop(creds.key, asset, p, o).catch((e) => `${p.key} : stop Hyperliquid non posé (${(e as Error).message.slice(0, 80)}), je réessaie`);
      if (stopNote && !message) message = stopNote;
      p.live = { price, pnlPct: perpsChange(p.side, entry, price) * 100, at: now };
      const hitTarget = p.target != null && (p.side === "long" ? price >= p.target : price <= p.target);
      const exit = isRangePos
        ? ((p.side === "long" ? price <= (p.stop ?? 0) : price >= (p.stop ?? Infinity)) ? "stop_loss" : hitTarget ? "objectif" : rangeOut)
        : exitCheck({ side: p.side, entry, price, stop: p.stop ?? entry, initialRisk: p.initialRisk ?? entry * 0.03, openedAt: p.openedAt ?? now, interval: iv }, now);
      if (exit) {
        await hlMarketOrder(creds.key, asset, p.side === "short", o.size, price, true);
        if (p.stopOid) await hlCancel(creds.key, asset, p.stopOid).catch(() => null);
        const pnl = await realizedPnl(creds.account, p.key, p.openedAt ?? now - 86_400_000);
        message = recordClose(admin, mem, cfg, p.key, value, pnl, exit);
        await save(admin, mem, { ...patch, ...mirror(mine), last_value_usd: value, last_message: message });
        return "close";
      }
    }
    // stops orphelins (position fermée, ordre resté) : nettoyés pour ne pas encombrer le compte
    // 28/11 : toutes les 10 min, TOUT stop « fermeture seulement » qui n'est le stop d'aucune position suivie est annulé
    // (avant : seulement sans position ouverte ; un vieux stop resté après une annulation ratée pouvait fermer une
    // nouvelle position du même sens sur le même marché)
    if (now - (mem.hlOrphanAt ?? 0) > 10 * 60_000) {
      mem.hlOrphanAt = now;
      const tracked = new Set(Object.values(mine).map((p) => p.stopOid).filter((x): x is number => x != null));
      const orders = await hlOpenOrders(creds.account).catch(() => []);
      // sécurité : une position suivie SANS stop connu garde tous les stops de son marché (ils sont peut-être sa seule protection)
      const unprotected = new Set(Object.values(mine).filter((p) => !p.stopOid).map((p) => p.key));
      for (const od of orders) if (od.isTrigger && od.reduceOnly && !tracked.has(od.oid) && !unprotected.has(od.coin)) await hlCancel(creds.key, await hlAsset(od.coin), od.oid).catch(() => null);
    }
    const held = Object.values(mine);
    const posText = held.map((p) => `${p.side === "long" ? "long" : "short"} ${p.key} ${p.live ? `${p.live.pnlPct >= 0 ? "+" : ""}${p.live.pnlPct.toFixed(2)} %` : ""}`).join(", ");
    const hold = async (msg: string, blocked: string | null = null) => {
      mem.mindset = mindset(brain, { inPosition: held.length > 0, blocked, goalPct: (value / Number(bot.goal_usd)) * 100 });
      await save(admin, mem, { ...patch, ...mirror(mine), last_value_usd: value, last_message: message || (held.length ? `${msg} · ${posText}` : msg) });
      return "hold";
    };
    if (paused) return await hold("En pause : aucune nouvelle entrée.");

    // 6. Entrées : une par marché, sur les stratégies validées par le chercheur.
    mem.signal = pruneSignal(mem.signal, cfg.plans.map((x) => x.asset));
    if (!cfg.plans.length) return await hold(cfg.autopilot ? "Pilote automatique : j'attends que le chercheur valide une stratégie perps." : "Aucune stratégie perps choisie.");
    if (held.length >= cfg.maxPositions) return await hold(`${held.length} position(s) ouverte(s), maximum atteint`);
    const blocked = riskGate(mem, value, now, cfg.dailyStop ? L.dailyLoss : Infinity);
    if (blocked) return await hold(blocked, blocked);
    const notes: string[] = [];
    for (const plan of cfg.plans as PerpsPlan[]) {
      const M = marketOf(plan.asset);
      if (!M || mine[plan.asset]) continue;
      const setup = plan.family && isSetup(plan.family) ? plan.family : null;
      const params = plan.params as Params;
      const iv: Interval = plan.interval ?? "1h";
      const closed = lastClosedCandle(now, iv);
      mem.lastCandleBy ??= {};
      if (mem.lastCandleBy[plan.asset] === closed) continue;
      const benched = aggressive ? (brain.benched[plan.asset] ?? 0) > now : isBenched(brain, plan.asset, now);
      if (benched) { mem.lastCandleBy[plan.asset] = closed; notes.push(`${plan.asset} sur le banc après une série difficile`); continue; }
      const c = await getCandles(M.candles, iv, 400, now);
      mem.lastCandleBy[plan.asset] = closed;
      const extra: Extra = setup === "funding" ? { funding: await fundingHistory(plan.asset, now - 2 * 86_400_000, now).catch(() => []) } : {};
      const sig = setup ? setupSignal(setup, c, sideMult(cfg.bias, "short") > 0, plan.params as SetupParams, extra) : trendSignal(c, sideMult(cfg.bias, "short") > 0, params);
      const mult = sig.side ? sideMult(cfg.bias, sig.side) : 0;
      if (!sig.side || mult === 0) { notes.push(sig.side ? `${plan.asset} : ${sig.side} désactivé par ta barre longs/shorts` : `${plan.asset} : ${sig.reason}`); continue; }
      const price = mids[plan.asset] ?? 0;
      if (!(price > 0)) { notes.push(`${plan.asset} : prix indisponible`); continue; }
      // 28/11 : rebond — l'objectif doit valoir 4 fois l'aller-retour Hyperliquid (même règle que le chercheur)
      const fee = M.feePct ?? HL_RESEARCH_FEE; // même coût que le chercheur pour ce marché
      if (setup === "rebond" && expectedMove(sig) < EDGE.mult * 2 * fee) { notes.push(`${plan.asset} : rebond ignoré, objectif à ${(expectedMove(sig) * 100).toFixed(2)} % < ${(EDGE.mult * 2 * fee * 100).toFixed(2)} % (4 × les frais)`); continue; }
      const asset = await hlAsset(plan.asset);
      const dist = Math.abs(sig.price - sig.stop);
      const stop = sig.side === "long" ? price - dist : price + dist;
      const conv = conviction(plan.score);
      const confidence = riskFactor(plan.confidence) * (cfg.extraSoft ? EXTRA_SOFT.riskMult : 1);
      const vol = volScale(c);
      const wanted = Math.min(L.maxRisk, riskPerTrade(brain) * L.riskMult * conv) * mult * confidence * vol;
      const room = L.maxRisk * TOTAL_RISK.perpsMult - openRisk(held, value);
      const risk = Math.min(wanted, room);
      if (risk < 0.002) { notes.push(`${plan.asset} : risque total des positions déjà au plafond`); continue; }
      const T = tradable(value, acct.withdrawable, mem.vault);
      const size = hlSizing(T.equity, T.usdc, price, stop, risk, asset.maxLeverage, Math.min(L.maxRisk, room)); // levier adapté au stop, jusqu'au maximum du marché
      if (!size) { notes.push(`${plan.asset} : signal ${sig.side} refusé — la position minimale de Hyperliquid (10 $) dépasserait ton plafond de risque, ou pas assez d'USDC disponibles`); continue; }
      // levier (marge isolée), ordre au marché, puis stop chez Hyperliquid ; si le stop ne peut pas être posé, on referme aussitôt
      const lev = await hlSetLeverage(creds.key, asset, size.leverage);
      // 28/11 : aucun vieux stop ne doit traîner sur ce marché avant d'entrer (il pourrait fermer la nouvelle position)
      for (const od of await hlOpenOrders(creds.account).catch(() => [])) if (od.coin === asset.name && od.isTrigger && od.reduceOnly) await hlCancel(creds.key, asset, od.oid).catch(() => null);
      // 28/11 : entrée « faiseur » d'abord (frais ~3 fois plus bas), complétée au marché si besoin
      const fill = await hlMakerEntry(creds.key, creds.account, asset, sig.side === "long", size.coins, price);
      const fillStop = sig.side === "long" ? fill.avgPx - dist : fill.avgPx + dist;
      const source = plan.source || "réglages de l'app";
      const pos: Position = {
        key: plan.asset, symbol: plan.asset, side: sig.side, entry: fill.avgPx, stop: fillStop, best: fill.avgPx, initialRisk: dist, openedAt: now, stopCandle: closed,
        posParams: plan.params, posInterval: iv, source, ...(setup ? { strategy: setup } : {}),
        ...((): Partial<Position> => { const regime = liveRegimeOf(c); return regime ? { regime, regimeFit: regimeFitLabel(setup ?? plan.family ?? "tendance", regime) } : {}; })(), ...("target" in sig && sig.target != null ? { target: (sig.target as number) + (fill.avgPx - sig.price) } : {}),
        collateralUsd: (fill.size * fill.avgPx) / lev, sizeUsd: fill.size * fill.avgPx, coinSize: fill.size,
        why: `${sig.reason} · stratégie : ${source} · ${L.name.toLowerCase()}, risque ${(size.risk * 100).toFixed(1)} %, levier x${lev} (marge isolée)${conv !== 1 ? `, confiance ×${conv}` : ""}${vol < 1 ? `, taille réduite (marché agité ×${vol})` : ""}${mem.vault ? ` (coffre de ${mem.vault.toFixed(2)} $ exclu)` : ""}`,
      };
      try {
        pos.stopOid = await hlPlaceStop(creds.key, asset, sig.side, fill.size, fillStop);
        pos.stopPx = fillStop;
      } catch (e) {
        await hlMarketOrder(creds.key, asset, sig.side === "short", fill.size, fill.avgPx, true).catch(() => null);
        admin.alert?.(`Bot perps : ${plan.asset} ouvert mais stop refusé par Hyperliquid (${(e as Error).message.slice(0, 100)}) : position refermée aussitôt par sécurité.`);
        message = `${plan.asset} : stop refusé par Hyperliquid, position refermée par sécurité.`; // prioritaire sur tout autre message
        return await hold(message);
      }
      mine[plan.asset] = pos;
      admin.addTrade("perps", { action: "open", asset: plan.asset, side: sig.side, collateral_usd: pos.collateralUsd, price: fill.avgPx, reason: sig.reason, source,
        detail: { pourquoi: pos.why, stop: fillStop, strategie: source, levier: lev, plateforme: "Hyperliquid", entree_faiseur_pct: Math.round((fill.makerSize / fill.size) * 100) } });
      mem.signal = `${plan.asset} : ${sig.reason}`;
      await save(admin, mem, { ...patch, ...mirror(mine), last_value_usd: value,
        last_message: `${sig.side === "long" ? "Long" : "Short"} ${plan.asset} ouvert à ${fmt(fill.avgPx)} $ (${L.name.toLowerCase()}) : ${pos.sizeUsd!.toFixed(2)} $ x${lev}, risque ${(size.risk * 100).toFixed(1)} %, stop ${fmt(fillStop)} $ posé chez Hyperliquid.` });
      return "open";
    }
    if (notes.length) mem.signal = notes.join(" · ");
    return await hold(notes.length ? `Pas d'entrée : ${notes.join(" · ")}.` : mem.signal || "En attente de la prochaine bougie.");
  } catch (e) {
    mem.errStreak = prevErr;
    errStreak(admin, mem, "Bot perps", (e as Error).message);
    await save(admin, mem, { ...patch, ...mirror(mine), last_value_usd: value, last_message: `Erreur : ${(e as Error).message}`.slice(0, 300) + " — je réessaie au prochain tick." });
    return "error";
  }
}

/** Fermeture : résultat réel (gains réalisés − frais) ; sinon dernière valeur connue. Une part du gain va au coffre. */
function recordClose(admin: Admin, mem: Memory, cfg: PerpsConfig, coin: string, value: number, pnlUsd: number | null, reason: string) {
  const p = mem.positions?.[coin];
  const pnl = pnlUsd ?? ((p?.lastValueUsd ?? 0) - (p?.collateralUsd ?? 0));
  const pnlPct = value > 0 ? (pnl / value) * 100 : 0;
  mem.vault = addToVault(mem.vault, pnl, cfg.vaultPct);
  admin.addTrade("perps", { action: "close", asset: coin, side: p?.side, collateral_usd: (p?.collateralUsd ?? 0) + pnl, price: p?.live?.price, pnl_usd: pnl, reason, source: p?.source,
    detail: { pourquoi: label(reason), entree: p?.entry, stop: p?.stop, strategie: p?.source, duree_h: p?.openedAt ? Math.round((Date.now() - p.openedAt) / 360_000) / 10 : null, entree_pourquoi: p?.why, coffre: mem.vault, plateforme: "Hyperliquid", note: "résultat hors financement horaire (funding), qui s'ajoute ou se retire du compte à part",
      ...(pnlUsd == null ? { estimation: "résultat estimé (exécutions Hyperliquid illisibles)" } : {}),
      ...(p?.regimeFit ? { regime: p.regime, regime_accord: p.regimeFit } : {}) } });
  learn(mem.brain ?? newBrain(value), coin, pnlPct, value, Date.now(), stopProtects(p) && /stop/.test(String(reason ?? "")));
  if (lossPause(pnl, stopProtects(p) && /stop/.test(String(reason ?? "")))) mem.cooldownUntil = Date.now() + cooldownMs(p?.posInterval); // sortie à l'équilibre par le stop : pas de pause
  if (mem.positions) delete mem.positions[coin];
  return `Position ${coin} fermée (${label(reason)}) : ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)} $ (${pnlPct.toFixed(1)} % du capital).${pnl > 0 && cfg.vaultPct ? ` ${cfg.vaultPct} % du gain mis au coffre.` : ""}`;
}

/** Ferme toutes les positions Hyperliquid (arrêt d'urgence, fin de mission) et annule les stops. */
export async function liquidateHl(admin: Admin, bot: PerpsRow, outcome: "success" | "destroyed" | "stopped", message: string) {
  const mem = loadMemory(bot.price_history);
  const mine = migratePositions(mem, bot);
  const failures: string[] = [];
  try {
    const { account, key } = hlCredentials();
    const [acct, mids] = await Promise.all([hlAccount(account), hlMids()]);
    for (const o of acct.positions) {
      try {
        const asset = await hlAsset(o.coin);
        await hlMarketOrder(key, asset, o.side === "short", o.size, mids[o.coin] ?? o.entryPx, true);
        const pnl = await realizedPnl(account, o.coin, mine[o.coin]?.openedAt ?? Date.now() - 86_400_000);
        admin.addTrade("perps", { action: "close", asset: o.coin, side: o.side, collateral_usd: o.valueUsd, pnl_usd: pnl ?? o.pnlUsd, reason: outcome, source: mine[o.coin]?.source, detail: { pourquoi: message, plateforme: "Hyperliquid" } });
        delete mine[o.coin];
      } catch (e) { failures.push(`${o.coin} : ${(e as Error).message}`); }
    }
    for (const od of await hlOpenOrders(account).catch(() => [])) if (od.reduceOnly) await hlCancel(key, await hlAsset(od.coin), od.oid).catch(() => null);
  } catch (e) { failures.push((e as Error).message); }
  admin.update("perps", {
    status: failures.length ? "running" : outcome, price_history: mem as never, last_tick_at: new Date().toISOString(), ...mirror(mine),
    last_message: (failures.length ? `${message} Fermeture impossible (${failures.join(", ")}) : je garde la main.` : message).slice(0, 300),
  });
}

function mirror(mine: Record<string, Position>): Partial<PerpsRow> {
  const p = Object.values(mine)[0];
  return { position_pubkey: null, position_asset: p?.key ?? null, position_side: p?.side ?? null, entry_price: p?.entry ?? null };
}
async function save(admin: Admin, mem: Memory, fields: Partial<PerpsRow>) {
  admin.update("perps", { price_history: mem, last_tick_at: new Date().toISOString(), ...fields });
}
const fmt = (n: number) => (n >= 100 ? n.toFixed(2) : n >= 1 ? n.toFixed(4) : n.toPrecision(4));
function label(reason?: string) {
  return reason === "stop_hl" ? "stop posé chez Hyperliquid" : reason === "fermee_ailleurs" ? "fermée hors du bot (ou liquidée)" : reason === "objectif" ? "objectif atteint"
    : reason === "trailing_stop" ? "stop suiveur, gain protégé" : reason === "stop_loss" ? "stop loss" : reason === "time_stop" ? "position sans élan"
    : reason === "orb_temps" ? "ORB : objectif non atteint à temps" : reason === "vwap_atteint" ? "retour au prix moyen du jour (VWAP) atteint" : reason === "vwap_temps" ? "VWAP : fin de journée sans retour"
    : reason === "funding_temps" ? "funding : délai écoulé" : reason === "range_temps" ? "range : pas de retour à la moyenne à temps" : reason ?? "sortie";
}
function errStreak(admin: Admin, mem: Memory, who: string, msg: string) {
  mem.errStreak = (mem.errStreak ?? 0) + 1;
  if (mem.errStreak === 5 || mem.errStreak % 60 === 0) admin.alert?.(`${who} : la même panne se répète depuis ${mem.errStreak} minutes (${msg.slice(0, 120)}). Les positions restent protégées par leurs stops chez Hyperliquid ; vérifie l'app.`);
}
