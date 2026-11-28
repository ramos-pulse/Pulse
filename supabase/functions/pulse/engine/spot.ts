// Serveur uniquement : BOT 1 — spot Solana. Jusqu'à 3 positions en même temps (une par token), risque total plafonné.
//
// Protections : coffre à gains (une part de chaque gain n'est plus jamais retradée), prise de bénéfices partielle
// (la moitié vendue à +1,5 R, stop remonté au prix d'entrée), filtre de marché (pas d'achat quand le BTC chute fort).
import type { BotState, Store, TradeRow } from "../store.ts";
import { isBenched, learn, mindset, newBrain, optimize, riskPerTrade } from "./brain.ts";
import { candles as getCandles, hourlyCandles, lastClosedCandle } from "./candles.ts";
import { executeSwap, getPrices, getQuote, verifyToken } from "./jupiter.ts";
import { getBalances, loadKeyPairFrom, txStatus, waitForTx, type Balances } from "./solana.ts";
import { dexPrices, tokenLiquidity } from "./dex.ts";
import { FRESH, freshStake } from "./agents.ts";
import { isSetup, setupExit, setupSignal, trailParams, TRAILING, type SetupParams } from "./setups.ts";
import {
  addToVault, applyTransfer, conviction, pruneSignal, atr, detectTransfer, DEFAULT_PARAMS, dayKey, exitCheck, loadConfig, loadMemory, marketFilter, migratePositions, missionEnd, PARTIAL, PRESETS, RISK, riskFactor, riskGate,
  EXTRA_SOFT, cooldownMs, exitSlippageBps, floorOf, solReserveAlert, volScale, groupOf, LIQUIDITY, type SpotFamily,
  rsiExitSignal, rsiSignal, RULES, sampleCurve, SOL_MINT, TOKENS, allTokens, type TokenInfo, TOTAL_RISK, tradable, trailStop, trendSignal, USDC_MINT,
  type Interval, type Memory, type Params, type Position, type RsiParams, type Signal, type SpotConfig, type SpotStrategy,
} from "./strategy.ts";

type Admin = Store;
type BotRow = BotState;
type Token = TokenInfo;
type KeyPair = Parameters<typeof executeSwap>[2];

const WALLET_ENV = "BOT_WALLET_PRIVATE_KEY";
const MIN_POSITION_USD = 1.5;    // en dessous : poussière, pas une position
const SPOT_COST = 0.003;         // coût estimé par côté (frais + slippage) pour le backtest
const allMints = () => [USDC_MINT, ...allTokens().map((t) => t.mint)];
const tokenOf = (mint: string | null | undefined) => allTokens().find((t) => t.mint === mint);
const symbolOf = (mint: string) => tokenOf(mint)?.symbol ?? mint.slice(0, 4);

export async function getWalletAddress(): Promise<string | null> {
  try { return (await loadKeyPairFrom(WALLET_ENV)).address; } catch { return null; }
}

/** Valeur du portefeuille + indique si TOUS les actifs détenus ont un prix (sinon aucune décision de fin de mission). */
export function portfolio(b: Balances, prices: Record<string, number>, totalSol: number) {
  let value = b.usdc * (prices[USDC_MINT] ?? 1);
  let complete = true;
  const solP = prices[SOL_MINT];
  if (solP) value += totalSol * solP; else if (totalSol > 0.001) complete = false;
  for (const t of allTokens()) {
    if (t.mint === SOL_MINT) continue;
    const q = b.ui[t.mint] ?? 0;
    if (q <= 0) continue;
    const p = prices[t.mint];
    if (p) value += q * p; else complete = false;
  }
  return { value, complete };
}

/**
 * Tokens trop récents : Jupiter ne publie pas encore leur prix « marché ». Sans ça ils compteraient pour 0 $
 * (fausse perte, fausse « perte du jour »). On les estime au prix réellement obtenable en les revendant.
 */
export async function fillMissingPrices(b: Balances, prices: Record<string, number>): Promise<Record<string, number>> {
  const missing: string[] = [];
  for (const t of allTokens()) {
    const raw = b.raw[t.mint] ?? 0n, ui = b.ui[t.mint] ?? 0;
    if (t.mint === SOL_MINT || prices[t.mint] || raw <= 0n || ui <= 0) continue;
    const q = await getQuote(t.mint, USDC_MINT, raw, RULES.exitSlippageBps).catch(() => null);
    const px = q ? Number(q.outAmount) / 1e6 / ui : 0;
    if (px > 0) prices[t.mint] = px; else missing.push(t.mint);
  }
  // dernier recours : DexScreener (prix de la paire la plus liquide)
  if (missing.length) Object.assign(prices, await dexPrices(missing).catch(() => ({})));
  return prices;
}

export async function currentValue() {
  const { address } = await loadKeyPairFrom(WALLET_ENV);
  const [prices, b] = await Promise.all([getPrices(allMints()), getBalances(address)]);
  await fillMissingPrices(b, prices);
  return { address, valueUsd: portfolio(b, prices, b.sol).value };
}

/** Le portefeuille fait foi : détient-on vraiment ce jeton ? */
function holds(b: Balances, mint: string, prices: Record<string, number>): boolean {
  const raw = b.raw[mint] ?? 0n;
  if (raw <= 0n) return false;
  const p = prices[mint];
  return p ? (b.ui[mint] ?? 0) * p >= MIN_POSITION_USD : true;
}

/** Vente avec marge de prix adaptée à la liquidité et envoi privé. Renvoie la signature et les USDC attendus (contrôle après coup). */
async function sell(mint: string, amount: bigint, owner: string, keyPair: KeyPair, protect = true) {
  if (amount <= 0n) throw new Error("rien à vendre");
  const probe = await getQuote(mint, USDC_MINT, amount, RULES.exitSlippageBps);
  const bps = exitSlippageBps(Number(probe.priceImpactPct));
  const quote = bps === RULES.exitSlippageBps ? probe : await getQuote(mint, USDC_MINT, amount, bps).catch(() => probe);
  return { sig: await executeSwap(quote, owner, keyPair, { protect }), expectedUsd: Number(quote.outAmount) / 1e6 };
}
/** Envoi privé (Jito) sauf si un envoi privé vient d'échouer : on repasse par la voie normale pendant 15 minutes. */
const protectNow = (mem: Memory, now: number) => !(mem.jitoMissAt && now - mem.jitoMissAt < 15 * 60_000);
/** Écart toléré entre le prix coté et le prix obtenu avant alerte (sandwich probable). */
const FILL_ALERT = 0.006;

/** Perte si le stop de chaque position est touché, en part du capital. */
function openRisk(positions: Position[], b: Balances, valueUsd: number) {
  if (!(valueUsd > 0)) return 0;
  return positions.reduce((s, p) => {
    const entry = p.entry ?? p.live?.price ?? 0, qty = b.ui[p.key] ?? 0; // depuis l'entrée (28/11) : un gain rendu ne bloque plus les entrées
    return s + Math.max(0, (entry - (p.stop ?? entry)) * qty);
  }, 0) / valueUsd;
}

// ------------------------------------------------------------------------------------------------
export async function runTick(admin: Admin): Promise<string> {
  const bot = admin.bot("spot");
  const mem: Memory = loadMemory(bot.price_history);
  const positions = migratePositions(mem, bot);
  // En pause : plus aucune entrée, mais les positions ouvertes restent gérées (le spot n'a pas de stop on-chain).
  const paused = bot.status === "paused";
  // En pause sans position : on relit quand même le portefeuille (valeur à jour, dépôts et retraits détectés).
  if (!(bot.status === "running" || paused)) return "idle";
  const now = Date.now();
  const cfg = loadConfig(bot.config);
  const patch: Partial<BotRow> = {};
  let message = "";
  const hadPending = !!mem.pending; // une transaction en cours change les soldes : pas de détection de transfert ce tick

  // 1. Données. Sans soldes on ne fait RIEN (mais on ne s'arrête pas pour autant).
  let address: string, keyPair: KeyPair, b: Balances, prices: Record<string, number>;
  try {
    ({ address, keyPair } = await loadKeyPairFrom(WALLET_ENV));
    [b, prices] = await Promise.all([getBalances(address), getPrices(allMints()).catch(() => ({} as Record<string, number>))]);
    await fillMissingPrices(b, prices);
  } catch (e) {
    errStreak(admin, mem, "Bot spot", (e as Error).message);
    await save(admin, mem, { last_message: `Données indisponibles (${(e as Error).message.slice(0, 80)}). Je réessaie dans une minute.` });
    return "data_unavailable";
  }
  const prevErr = mem.errStreak ?? 0;
  mem.errStreak = 0;
  patch.wallet_address = address;
  let { value, complete } = portfolio(b, prices, b.sol);
  mem.brain = mem.brain ?? newBrain(value);
  const brain = mem.brain;

  // 2. Transaction en attente : on attend la vérité de la blockchain avant toute nouvelle décision.
  if (mem.pending) {
    const r = await settle(admin, bot, mem, cfg, address, value);
    if (r === "pending") {
      await save(admin, mem, { ...patch, last_message: "Transaction en cours de confirmation…" });
      return "pending";
    }
    message = r;
    b = await getBalances(address);
    ({ value, complete } = portfolio(b, prices, b.sol));
  }

  // 3. Réconciliation : les positions, c'est ce que contient le portefeuille, pas ce que dit la base.
  for (const p of Object.values(positions)) {
    if (holds(b, p.key, prices)) { p.missing = 0; continue; }
    // une lecture vide isolée (RPC capricieux) ne doit pas faire oublier une position et son stop : 2 ticks de suite
    p.missing = (p.missing ?? 0) + 1;
    if (p.missing >= 2) {
      const left = b.ui[p.key] ?? 0, px = prices[p.key] ?? 0;
      if ((b.raw[p.key] ?? 0n) > 0n) { // les jetons sont là mais ne valent presque plus rien : c'est une perte, on l'inscrit
        const worth = left * px, cost = p.costUsd ?? 0;
        admin.addTrade("spot", { side: "sell", symbol: p.symbol, mint: p.key, amount_usd: worth, price: px, pnl_usd: worth - cost, reason: "effondrement", source: p.source,
          detail: { pourquoi: `Valeur tombée sous ${MIN_POSITION_USD} $ (${worth.toFixed(2)} $ restants) : token invendable ou presque, position clôturée comme perte. Les jetons restent dans le portefeuille.`, entree: p.entry, strategie: p.source } });
        message = `${p.symbol} s'est effondré (${worth.toFixed(2)} $ restants sur ${cost.toFixed(2)} $) : position clôturée comme perte.`;
      } else message = `Position ${p.symbol} introuvable dans le portefeuille : oubliée.`;
      delete positions[p.key];
      mem.signal = undefined; // plus d'analyse périmée sur ce token
    }
  }
  // « nouveau token repéré » alors qu'aucun nouveau token n'est détenu : message périmé
  if (mem.signal?.endsWith("nouveau token repéré par l'agent") && !mem.pending && !Object.values(positions).some((p) => p.strategy === "nouveau")) mem.signal = undefined;
  for (const t of allTokens()) {
    if (t.mint === SOL_MINT || positions[t.mint] || !holds(b, t.mint, prices) || !prices[t.mint]) continue;
    const price = prices[t.mint]!;
    positions[t.mint] = { key: t.mint, symbol: t.symbol, side: "long", entry: price, costUsd: (b.ui[t.mint] ?? 0) * price, best: price, stop: price * 0.95,
      initialRisk: price * 0.05, openedAt: now, source: "jetons trouvés dans le portefeuille", why: "reprise de jetons présents dans le portefeuille (stop de sécurité −5 %)" };
    message = `Jetons ${t.symbol} trouvés dans le portefeuille : je reprends leur gestion (stop de sécurité −5 %).`;
  }
  // Dépôt ou retrait (USDC ou SOL arrivés/partis sans trade) : ce n'est ni un gain ni une perte
  if (!hadPending) {
    const d = detectTransfer(mem, b.usdc, b.sol, prices[SOL_MINT] ?? 0, value);
    if (d) {
      if (bot.start_value_usd != null) patch.start_value_usd = Math.max(0.01, Number(bot.start_value_usd) + d);
      applyTransfer(mem, d);
      admin.addTrade("spot", { side: d > 0 ? "deposit" : "withdraw", symbol: "USDC", amount_usd: Math.abs(d), reason: d > 0 ? "dépôt" : "retrait",
        detail: { pourquoi: `${d > 0 ? "Dépôt" : "Retrait"} de ${Math.abs(d).toFixed(2)} $ détecté (aucun trade en cours) : point de départ, perte du jour et courbe ajustés, ce n'est ni un gain ni une perte.` } });
      message = `${d > 0 ? "Dépôt" : "Retrait"} de ${Math.abs(d).toFixed(2)} $ détecté : compteurs ajustés (ni gain ni perte).`;
    }
  }
  mem.lastUsdc = b.usdc; mem.lastSol = b.sol;
  sampleCurve(mem, value, now);
  const solAlert = solReserveAlert(mem, b.sol, now, "Bot spot");
  if (solAlert) { admin.alert?.(solAlert); message ||= solAlert; }

  // 4. Fin de mission (uniquement sur données complètes : plus jamais de faux arrêt).
  const end = missionEnd({
    now, endAt: RULES.destroyAtDeadline && bot.end_at ? Date.parse(bot.end_at) : Infinity,
    goalUsd: Number(bot.goal_usd), valueUsd: value, floorUsd: floorOf(bot.start_value_usd, RULES.floorUsd), complete,
  });
  if (end && !paused) {
    const outcome = end === "success" ? "success" : end === "destroyed" ? "destroyed" : "stopped";
    const msg = end === "success" ? "Mission réussie ! Objectif atteint, gains sécurisés en USDC."
      : end === "destroyed" ? "Date limite atteinte : positions vendues." : `Capital sous ${floorOf(bot.start_value_usd, RULES.floorUsd).toFixed(2)} $ (30 % du départ) : je protège ce qui reste.`;
    await save(admin, mem, { ...patch, ...mirror(positions), last_value_usd: value });
    await liquidate(admin, { ...bot, ...patch, price_history: mem } as BotRow, outcome, msg);
    return outcome;
  }

  try {
    // 5. Gestion de chaque position : stop suiveur (à chaque bougie), prise partielle, sortie vérifiée chaque minute.
    //    Une seule transaction par tick : la suivante attend la minute d'après.
    for (const p of Object.values(positions)) {
      if (p.missing) continue; // pas vue à cette minute : on ne décide rien sur elle
      const token = tokenOf(p.key);
      const amount = b.raw[p.key] ?? 0n;
      let livePrice = prices[p.key];
      try { // prix réellement obtenable en vendant TOUT maintenant (slippage compris)
        const q = await getQuote(p.key, USDC_MINT, amount, RULES.exitSlippageBps);
        livePrice = Number(q.outAmount) / 1e6 / (b.ui[p.key] ?? 1);
        p.quoteErr = undefined;
      } catch (e) { p.quoteErr = (e as Error).message.slice(0, 120); /* on garde le prix de marché */ }
      if (!livePrice) livePrice = (await dexPrices([p.key]).catch(() => ({} as Record<string, number>)))[p.key];
      if (!livePrice) { // aucun prix nulle part : on le dit au lieu de sauter la position en silence
        message ||= `${p.symbol} : aucun prix disponible (${p.quoteErr ?? "Jupiter et DexScreener muets"}), stop non vérifié cette minute.`;
        continue;
      }
      const entry = p.entry ?? livePrice;
      const iv: Interval = p.posInterval ?? "1h";
      const closed = lastClosedCandle(now, iv);
      const isRsi = p.strategy === "rsi";
      const fam = p.strategy && isSetup(p.strategy) ? p.strategy : null;
      const fixed = !!fam && !TRAILING.includes(fam); // ORB, VWAP : stop fixe, objectif, sortie à la clôture des bougies
      let rsiExit = false, setupOut: string | null = null;
      const isFresh = p.strategy === "nouveau";
      if (token && !isFresh && p.stopCandle !== closed) {
        if (fixed) {
          const c = await getCandles(token.candles, iv, 260, now).catch(() => []);
          if (c.length > 40) { setupOut = setupExit(fam!, c, "long", p.posParams as SetupParams, Math.round((now - (p.openedAt ?? now)) / (iv === "15m" ? 900_000 : 3_600_000)), p.openedAt ?? now); p.stopCandle = closed; }
        } else if (isRsi) { // décision à la clôture de chaque bougie : RSI repassé au-dessus du seuil de sortie ?
          const rp = (p.posParams as RsiParams | undefined) ?? cfg.rsi;
          const c = await getCandles(token.candles, iv, rp.rsiPeriod * 6 + 10, now).catch(() => []);
          if (c.length > rp.rsiPeriod + 2) { const r = rsiExitSignal(c, rp); rsiExit = r.exit; p.stopCandle = closed; }
        } else {
          const params = fam ? trailParams(p.posParams as SetupParams) : (p.posParams as Params | undefined) ?? cfg.trend ?? PRESETS[brain.preset[p.symbol] ?? "standard"];
          const c = await getCandles(token.candles, iv, 40, now).catch(() => []);
          if (c.length > 20) {
            p.best = Math.max(p.best ?? entry, c.at(-1)!.c);
            p.stop = trailStop("long", p.stop ?? entry * 0.95, p.best, atr(c, 14).at(-1)!, params);
            p.stopCandle = closed;
          }
        }
      }
      const stop = p.stop ?? entry * 0.95;
      const pnlPct = p.costUsd ? (((b.ui[p.key] ?? 0) * livePrice) / p.costUsd - 1) * 100 : (livePrice / entry - 1) * 100;
      p.live = { price: livePrice, pnlPct, at: now };
      // Sortie d'urgence : la liquidité du token s'effondre (souvent le début d'une arnaque) — vérifiée toutes les 10 minutes
      let liqOut: string | null = null;
      if (p.liqAtEntry && now - (p.liqCheckedAt ?? 0) >= (isFresh ? 2 * 60_000 : LIQUIDITY.checkMs)) {
        p.liqCheckedAt = now;
        const liq = (await tokenLiquidity([p.key]).catch(() => ({} as Record<string, number>)))[p.key];
        if (liq != null && liq < p.liqAtEntry * LIQUIDITY.collapse) liqOut = "liquidite_effondree";
      }
      const exit = liqOut ?? (isFresh
        ? (livePrice <= stop ? "stop_loss" : p.target != null && livePrice >= p.target ? "objectif" : now - (p.openedAt ?? now) >= FRESH.maxHoldMs ? "nouveau_temps" : null)
        : isRsi
        ? (livePrice <= stop ? "stop_loss" : rsiExit ? "rsi_exit" : null)
        : fixed
        ? (livePrice <= stop ? "stop_loss" : p.target != null && livePrice >= p.target ? "objectif" : setupOut)
        : exitCheck({ side: "long", entry, price: livePrice, stop, initialRisk: p.initialRisk ?? entry * 0.05, openedAt: p.openedAt ?? now, interval: iv }, now));
      if (exit) {
        const { sig, expectedUsd } = await sell(p.key, amount, address, keyPair, protectNow(mem, now));
        mem.pending = { kind: "sell", sig, at: now, mint: p.key, usdcBefore: b.usdc, reason: exit, expectedUsd };
        const r = (await waitForTx(sig)) === "pending" ? "pending" : await settle(admin, bot, mem, cfg, address, value);
        await save(admin, mem, { ...patch, ...mirror(positions), last_value_usd: value, last_message: r === "pending" ? `Vente ${p.symbol} envoyée (${label(exit)}), confirmation en cours…` : r });
        return "sell";
      }
      // Prise de bénéfices partielle : la moitié à +1,5 R, puis stop au prix d'entrée (le reste ne peut plus perdre)
      if (cfg.partialTp && !fixed && !isFresh && !p.partialDone && (p.initialRisk ?? 0) > 0 && livePrice >= entry + PARTIAL.atR * p.initialRisk!) {
        const half = amount / 2n;
        const remainder = (b.ui[p.key] ?? 0) * livePrice * (1 - PARTIAL.fraction);
        if (remainder < MIN_POSITION_USD * 2) { // couper en deux laisserait un reste minuscule : on vend tout, gain encaissé
          const { sig, expectedUsd } = await sell(p.key, amount, address, keyPair, protectNow(mem, now));
          mem.pending = { kind: "sell", sig, at: now, mint: p.key, usdcBefore: b.usdc, reason: "prise_totale", expectedUsd };
          const r = (await waitForTx(sig)) === "pending" ? "pending" : await settle(admin, bot, mem, cfg, address, value);
          await save(admin, mem, { ...patch, ...mirror(positions), last_value_usd: value, last_message: r === "pending" ? `Prise de bénéfices ${p.symbol} envoyée…` : r });
          return "sell";
        }
        if (half > 0n && (b.ui[p.key] ?? 0) * livePrice * PARTIAL.fraction >= RISK.minOrderUsd) {
          const { sig, expectedUsd } = await sell(p.key, half, address, keyPair, protectNow(mem, now));
          mem.pending = { kind: "partial", sig, at: now, mint: p.key, usdcBefore: b.usdc, rawBefore: amount.toString(), reason: "prise_partielle", expectedUsd };
          const r = (await waitForTx(sig)) === "pending" ? "pending" : await settle(admin, bot, mem, cfg, address, value);
          await save(admin, mem, { ...patch, ...mirror(positions), last_value_usd: value, last_message: r === "pending" ? `Prise de bénéfices partielle ${p.symbol} envoyée…` : r });
          return "partial";
        }
      }
    }
    const held = Object.values(positions);
    const posText = held.map((p) => `${p.symbol} ${p.live ? `${p.live.pnlPct >= 0 ? "+" : ""}${p.live.pnlPct.toFixed(2)} %` : ""}`).join(", ");

    if (paused) {
      await save(admin, mem, { ...patch, ...mirror(positions), last_value_usd: value, last_message: message || (held.length ? `En pause, positions gérées : ${posText}.` : "En pause : aucune nouvelle entrée.") });
      return "paused";
    }

    // 6. Entrées. PLANS du chercheur (pilote automatique ou stratégies appliquées), sinon réglages de l'app.
    const usePlans = cfg.autopilot || cfg.plans.length > 0;
    if (usePlans) mem.signal = pruneSignal(mem.signal, cfg.plans.map((x) => x.symbol)); // une stratégie retirée disparaît tout de suite du message
    const today = dayKey(now);
    const todo = !usePlans && cfg.strategy === "tendance" ? TOKENS.find((t) => brain.optimized?.[t.symbol] !== today) : undefined;
    if (todo) {
      const hist = await hourlyCandles(todo.candles, 1440, now).catch(() => null);
      if (hist && hist.length > 500) optimize(brain, todo.symbol, hist, { allowShort: false, feePct: SPOT_COST, leverageCap: RISK.maxSpotFraction }, today);
      else brain.optimized = { ...brain.optimized, [todo.symbol]: today };
    }
    const hold = async (msg: string) => {
      mem.mindset = mindset(brain, { inPosition: held.length > 0, blocked: null, goalPct: (value / Number(bot.goal_usd)) * 100 });
      await save(admin, mem, { ...patch, ...mirror(positions), last_value_usd: value, last_message: message || (held.length ? `${msg} · positions : ${posText}` : msg) });
      return "hold";
    };
    if (held.length >= cfg.maxPositions) return await hold(`${held.length} position(s) ouverte(s), maximum atteint`);
    const blocked = riskGate(mem, value, now, cfg.dailyStop ? RISK.dailyLoss : Infinity); // perte du jour : seulement si activée
    if (blocked) { mem.mindset = mindset(brain, { inPosition: held.length > 0, blocked, goalPct: (value / Number(bot.goal_usd)) * 100 }); return await hold(blocked); }
    // AGENT NOUVEAUX TOKENS (si activé) : un seul token récent à la fois, toute petite mise, 3 par jour au plus
    if (cfg.newTokens && !held.some((p) => p.strategy === "nouveau")) {
      const r = await freshEntry(admin, bot, mem, cfg, address, keyPair, b, value, now);
      if (r) { await save(admin, mem, { ...patch, ...mirror(positions), last_value_usd: value, last_message: r }); return "buy"; }
    }
    if (usePlans && cfg.plans.length === 0) { mem.signal = "Pilote automatique : aucune stratégie n'a encore passé la validation du chercheur."; return await hold("Pilote automatique : j'attends que le chercheur valide une stratégie."); }

    type Choice = { token: Token; sig: Signal & { target?: number }; strategy: SpotStrategy | SpotFamily; params: Params | RsiParams | SetupParams; interval: Interval; rank: number; risk: number; source: string; seenKey: string; closed: number };
    const choices: Choice[] = [];
    const notes: string[] = [];
    let analysed = 0;
    mem.seen = mem.seen ?? {};
    const candidates = usePlans
      ? cfg.plans.map((plan) => ({ plan, token: allTokens().find((t) => t.symbol === plan.symbol) })).filter((x) => x.token && !positions[x.token.mint])
      : [];
    for (const { plan, token } of candidates) {
      const key = `${plan.symbol}|${plan.interval}`, closedP = lastClosedCandle(now, plan.interval);
      if (mem.seen[key] === closedP) continue; // une bougie déjà jugée n'est pas réanalysée
      analysed++;
      // une bougie est « jugée » quand elle ne donne pas de signal ou quand le signal a été pris ;
      // un bon signal non pris (place ou risque déjà utilisés ce tick) est retenté à la minute suivante
      const done = () => { mem.seen![key] = closedP; };
      if ((brain.benched[token!.symbol] ?? 0) > now) { notes.push(`${token!.symbol} : sur le banc après des pertes`); done(); continue; }
      const check = await verifyToken(token!);
      if (!check.ok) { notes.push(`${token!.symbol} : refusé (${check.why})`); done(); continue; }
      try {
        const rsi = plan.family === "rsi";
        const setup = isSetup(plan.family) ? plan.family : null;
        const rp = plan.params as RsiParams;
        const c = await getCandles(token!.candles, plan.interval, rsi ? Math.max(rp.smaPeriod, rp.rsiPeriod * 6) + 40 : 400, now);
        const sig = rsi ? rsiSignal(c, rp) : setup ? setupSignal(setup, c, false, plan.params as SetupParams) : trendSignal(c, false, plan.params as Params);
        // stratégie non confirmée en réel : 75 % ; marché agité : taille réduite
        const risk = (rsi ? rp.riskPct / 100 : riskPerTrade(brain)) * riskFactor(plan.confidence) * volScale(c) * (cfg.extraSoft ? EXTRA_SOFT.riskMult : 1) * conviction(plan.score); // mise selon la confiance
        if (sig.side === "long") choices.push({ token: token!, sig, strategy: plan.family, params: plan.params, interval: plan.interval, rank: plan.score, risk, source: plan.source, seenKey: key, closed: closedP });
        else { notes.push(`${token!.symbol} ${plan.interval === "15m" ? "15 min" : "1 h"} : ${sig.reason}`); done(); }
      } catch { notes.push(`${token!.symbol} : historique indisponible`); }
    }
    if (!usePlans) {
      const closedH = lastClosedCandle(now);
      for (const token of TOKENS) {
        const key = `${token.symbol}|1h|app`;
        if (positions[token.mint] || mem.seen[key] === closedH) continue;
        analysed++;
        const done = () => { mem.seen![key] = closedH; };
        const benched = cfg.trend ? (brain.benched[token.symbol] ?? 0) > now : isBenched(brain, token.symbol, now);
        if (cfg.strategy === "tendance" && benched) { notes.push(`${token.symbol} : sur le banc`); done(); continue; }
        if (token.verify && !(await verifyToken(token)).ok) { notes.push(`${token.symbol} : non vérifié`); done(); continue; }
        try {
          const c = await hourlyCandles(token.candles, cfg.strategy === "rsi" ? Math.max(cfg.rsi.smaPeriod, cfg.rsi.rsiPeriod * 6) + 40 : 400, now);
          const params: Params | RsiParams = cfg.strategy === "rsi" ? cfg.rsi : cfg.trend ?? PRESETS[brain.preset[token.symbol] ?? "standard"] ?? DEFAULT_PARAMS;
          const sig = cfg.strategy === "rsi" ? rsiSignal(c, cfg.rsi) : trendSignal(c, false, params as Params);
          if (sig.side === "long") choices.push({ token, sig, strategy: cfg.strategy, params, interval: "1h", rank: sig.score, risk: cfg.strategy === "rsi" ? cfg.rsi.riskPct / 100 : riskPerTrade(brain), source: cfg.source ?? "réglages de l'app", seenKey: key, closed: closedH });
          else { notes.push(`${token.symbol} : ${sig.reason}`); done(); }
        } catch { notes.push(`${token.symbol} : historique indisponible`); }
      }
    }
    if (analysed === 0) return await hold(mem.signal || "En attente de la prochaine bougie.");
    choices.sort((a, c) => c.rank - a.rank);
    const pick = choices[0];
    if (!pick) {
      mem.signal = notes.join(" · ");
      return await hold(usePlans ? `Plans du chercheur : aucun signal pour l'instant (${cfg.plans.map((x) => x.symbol).join(", ")}).`
        : cfg.strategy === "rsi" ? `Aucun excès de baisse (RSI sous ${cfg.rsi.entry}) : j'attends.` : "Aucune cassure en tendance : j'attends, patience = argent.");
    }

    // Filtre de marché : pas d'achat quand le Bitcoin chute fort
    if (cfg.marketFilter) {
      const btc = await getCandles("BTC-USD", "1h", 230, now).catch(() => []);
      const f = marketFilter(btc);
      if (f.blocked) {
        for (const c of choices) mem.seen[c.seenKey] = c.closed;
        mem.signal = `${pick.token.symbol} : signal d'achat ignoré, BTC ${(f.change24h * 100).toFixed(1)} % sur 24 h${f.belowEma ? " et sous sa moyenne 200 h" : ""}`;
        return await hold(`Filtre de marché : le BTC chute (${(f.change24h * 100).toFixed(1)} % en 24 h), aucun achat pour l'instant.`);
      }
    }

    // 7. Entrée : taille au risque (hors coffre, risque total plafonné), cotation vérifiée, swap, confirmation.
    const T = tradable(value, b.usdc, mem.vault);
    const room = TOTAL_RISK.spot - openRisk(held, b, value);
    // tokens qui bougent ensemble (mêmes familles : grandes cryptos, memecoins, DeFi Solana) : une 2e position du même groupe = demi-risque
    const sameGroup = held.filter((p) => groupOf(p.symbol) === groupOf(pick.token.symbol)).length;
    const risk = Math.min(pick.risk * (sameGroup ? 0.5 : 1), room);
    if (risk < 0.002) { for (const c of choices) mem.seen[c.seenKey] = c.closed; }
    if (risk < 0.002) return await hold(`Signal ${pick.token.symbol} ignoré : risque total des positions ouvertes déjà au plafond (${(TOTAL_RISK.spot * 100).toFixed(0)} %).`);
    const perPositionCap = T.equity * Math.min(RISK.maxSpotFraction, 1 / cfg.maxPositions); // part égale : de la place pour chaque position
    const dist = (pick.sig.price - pick.sig.stop) / pick.sig.price;
    const sizeUsd = dist > 0 ? Math.min((T.equity * risk) / dist, perPositionCap, T.usdc) : 0;
    if (sizeUsd < RISK.minOrderUsd) { for (const c of choices) mem.seen[c.seenKey] = c.closed; }
    if (sizeUsd < RISK.minOrderUsd) return await hold(`Signal ${pick.token.symbol} mais pas assez d'USDC disponible (hors coffre) pour un ordre (min ${RISK.minOrderUsd} $).`);
    const closed = lastClosedCandle(now, pick.interval);
    mem.seen[pick.seenKey] = pick.closed; // signal pris (ou refusé ci-dessous) : bougie jugée
    const quote = await getQuote(USDC_MINT, pick.token.mint, BigInt(Math.floor(sizeUsd * 1e6)), RULES.spotSlippageBps);
    const impact = Number(quote.priceImpactPct) * 100;
    const fillPrice = sizeUsd / (Number(quote.outAmount) / 10 ** pick.token.decimals);
    if (impact > RULES.maxPriceImpactPct || fillPrice <= pick.sig.stop * 1.003) return await hold(`Signal ${pick.token.symbol} ignoré : exécution trop chère (impact ${impact.toFixed(2)} %) ou prix déjà trop loin.`);
    const liqAtEntry = pick.token.mint === SOL_MINT ? undefined : (await tokenLiquidity([pick.token.mint]).catch(() => ({} as Record<string, number>)))[pick.token.mint];
    const sig = await executeSwap(quote, address, keyPair, { protect: protectNow(mem, now) });
    mem.signal = `${pick.token.symbol} : ${pick.sig.reason}`;
    mem.pending = { kind: "buy", sig, at: now, mint: pick.token.mint, usdcBefore: b.usdc, expectedPrice: fillPrice, draft: {
      key: pick.token.mint, symbol: pick.token.symbol, side: "long", stop: pick.sig.stop, best: fillPrice, initialRisk: fillPrice - pick.sig.stop, openedAt: now,
      strategy: pick.strategy, posParams: pick.params, posInterval: pick.interval, source: pick.source, stopCandle: closed,
      ...(pick.sig.target != null ? { target: pick.sig.target * (fillPrice / pick.sig.price) } : {}), ...(liqAtEntry ? { liqAtEntry, liqCheckedAt: now } : {}),
      why: `${pick.sig.reason} · stratégie : ${pick.source} · risque ${(risk * 100).toFixed(1)} % du capital tradable${sameGroup ? " (demi-risque : un token du même groupe est déjà en portefeuille)" : ""}${mem.vault ? ` (coffre de ${mem.vault.toFixed(2)} $ exclu)` : ""}`,
    } };
    const r = (await waitForTx(sig)) === "pending" ? "pending" : await settle(admin, bot, mem, cfg, address, value);
    await save(admin, mem, { ...patch, ...mirror(positions), last_value_usd: value, last_message: r === "pending" ? `Achat ${pick.token.symbol} envoyé, confirmation en cours…` : r });
    return "buy";
  } catch (e) {
    mem.errStreak = prevErr;
    errStreak(admin, mem, "Bot spot", (e as Error).message);
    await save(admin, mem, { ...patch, ...mirror(positions), last_value_usd: value, last_message: `Erreur : ${(e as Error).message}`.slice(0, 300) + " — je réessaie au prochain tick." });
    return "error";
  }
}

// ------------------------------------------------------------------------------------------------
/**
 * Achat d'un token tout juste lancé repéré par l'agent (garde-fous déjà passés : émission et gel désactivés, liquidité,
 * ventes réelles, concentration). Mise de 2 à 5 $, stop −20 %, objectif +40 %, 4 h maximum, sortie d'urgence si la
 * liquidité s'effondre (contrôlée toutes les 2 minutes). Renvoie le message, ou null si rien n'est acheté.
 */
async function freshEntry(admin: Admin, bot: BotRow, mem: Memory, cfg: SpotConfig, address: string, keyPair: KeyPair, b: Balances, value: number, now: number): Promise<string | null> {
  const today = dayKey(now);
  mem.fresh ??= {};
  // valeur = jour de l'achat ; « skip:jour » = token examiné mais écarté (ne compte pas dans les 3 achats du jour)
  for (const [k, d] of Object.entries(mem.fresh)) if (d.replace(/^skip:/, "") < dayKey(now - 7 * 86_400_000)) delete mem.fresh[k];
  if (Object.values(mem.fresh).filter((d) => d === today).length >= FRESH.maxPerDay) return null;
  const T = tradable(value, b.usdc, mem.vault);
  const stake = Math.min(freshStake(T.equity), T.usdc);
  if (!(stake >= RISK.minOrderUsd) || stake * FRESH.stopPct > T.equity * 0.04) return null;
  const pick = allTokens().find((t) => t.extra === "nouveau" && t.active !== false && t.seenAt && now - t.seenAt < (cfg.extraSoft ? 30 : 15) * 60_000 && !mem.fresh![t.mint] && !(b.raw[t.mint] ?? 0n));
  if (!pick) return null;
  mem.fresh[pick.mint] = `skip:${today}`; // jamais deux tentatives sur le même token
  const quote = await getQuote(USDC_MINT, pick.mint, BigInt(Math.floor(stake * 1e6)), 100).catch(() => null);
  if (!quote) return `Nouveau token ${pick.symbol} : pas de cotation Jupiter, ignoré.`;
  const impact = Number(quote.priceImpactPct) * 100;
  if (impact > 1) return `Nouveau token ${pick.symbol} ignoré : impact de prix ${impact.toFixed(2)} % (trop peu liquide pour ${stake.toFixed(2)} $).`;
  const fillPrice = stake / (Number(quote.outAmount) / 10 ** pick.decimals);
  const liqAtEntry = (await tokenLiquidity([pick.mint]).catch(() => ({} as Record<string, number>)))[pick.mint];
  const sig = await executeSwap(quote, address, keyPair, { protect: protectNow(mem, now) });
  mem.fresh[pick.mint] = today; // achat réellement envoyé : compte dans la limite du jour
  mem.signal = `${pick.symbol} : nouveau token repéré par l'agent`;
  mem.pending = { kind: "buy", sig, at: now, mint: pick.mint, usdcBefore: b.usdc, expectedPrice: fillPrice, draft: {
    key: pick.mint, symbol: pick.symbol, side: "long", stop: fillPrice * (1 - FRESH.stopPct), target: fillPrice * (1 + FRESH.targetPct), best: fillPrice, initialRisk: fillPrice * FRESH.stopPct,
    openedAt: now, strategy: "nouveau", posInterval: "15m", source: "agent nouveaux tokens", ...(liqAtEntry ? { liqAtEntry, liqCheckedAt: now } : {}),
    why: `token lancé récemment, garde-fous anti-arnaque passés (émission et gel désactivés, liquidité, vraies ventes, pas de concentration) · mise ${stake.toFixed(2)} $, stop −${FRESH.stopPct * 100} %, objectif +${FRESH.targetPct * 100} %, 4 h maximum`,
  } };
  const r = (await waitForTx(sig)) === "pending" ? "pending" : await settle(admin, bot, mem, cfg, address, value);
  return r === "pending" ? `Achat du nouveau token ${pick.symbol} envoyé (${stake.toFixed(2)} $)…` : r;
}

// ------------------------------------------------------------------------------------------------
/** Règle une transaction en attente d'après la blockchain et le portefeuille. Renvoie un message, ou "pending". */
async function settle(admin: Admin, bot: BotRow, mem: Memory, cfg: SpotConfig, address: string, valueBefore: number): Promise<string> {
  const p = mem.pending!;
  const st = await txStatus(p.sig).catch(() => "pending" as const);
  if (st === "pending" && Date.now() - p.at < 120_000) return "pending";
  const mint = p.mint!;
  const positions = mem.positions ??= {};
  const [b, prices] = await Promise.all([getBalances(address), getPrices([USDC_MINT, mint]).catch(() => ({} as Record<string, number>))]);
  const held = holds(b, mint, prices);
  mem.pending = undefined;
  mem.lastUsdc = b.usdc; mem.lastSol = b.sol; // les soldes après le trade deviennent la nouvelle référence
  const sym = symbolOf(mint);
  void bot;

  const fillAlert = (what: string, gapPct: number) => {
    admin.alert?.(`Bot spot : ${what} ${sym} exécuté ${gapPct.toFixed(2)} % moins bien que le prix coté — possible sandwich ou marché très rapide.`);
  };
  if (p.kind === "buy") {
    if (!held) { if (st !== "failed") mem.jitoMissAt = Date.now(); return `Achat ${sym} non exécuté (${st}). Aucun fonds engagé.`; }
    const cost = Math.max(0.01, (p.usdcBefore ?? 0) - b.usdc);
    const qty = b.ui[mint] ?? 0;
    const entry = qty > 0 ? cost / qty : prices[mint] ?? 0;
    const d = p.draft ?? { key: mint, symbol: sym, side: "long" as const };
    const stop = d.stop && d.stop < entry ? d.stop : entry * 0.95;
    positions[mint] = { ...d, entry, costUsd: cost, best: Math.max(d.best ?? entry, entry), stop, initialRisk: entry - stop };
    const gap = p.expectedPrice ? (entry / p.expectedPrice - 1) * 100 : 0;
    if (gap > FILL_ALERT * 100) fillAlert("achat", gap);
    admin.addTrade("spot", { side: "buy", symbol: sym, mint, amount_usd: cost, price: entry, reason: mem.signal ?? "tendance", signature: p.sig, source: d.source,
      detail: { pourquoi: d.why, stop, strategie: d.source, unite: d.posInterval === "15m" ? "15 min" : "1 h", ecart_prix_pct: Math.round(gap * 100) / 100 } });
    return `Achat ${sym} confirmé : ${cost.toFixed(2)} $ à ${fmt(entry)} $, stop à ${fmt(stop)} $.`;
  }

  const pos = positions[mint];
  const proceeds = Math.max(0, b.usdc - (p.usdcBefore ?? 0));
  if (p.kind === "partial") {
    const before = BigInt(p.rawBefore ?? "0"), now = b.raw[mint] ?? 0n;
    if (!(before > 0n && now < (before * 3n) / 4n)) { if (st !== "failed") mem.jitoMissAt = Date.now(); return `Prise de bénéfices partielle ${sym} non exécutée (${st}) : je réessaie.`; }
    if (p.expectedUsd && proceeds < p.expectedUsd * (1 - FILL_ALERT)) fillAlert("vente partielle", (1 - proceeds / p.expectedUsd) * 100);
    const soldFrac = Number(before - now) / Number(before);
    const cost = (pos?.costUsd ?? proceeds) * soldFrac;
    const pnl = proceeds - cost;
    mem.vault = addToVault(mem.vault, pnl, cfg.vaultPct);
    if (pos) { pos.costUsd = (pos.costUsd ?? cost) - cost; pos.partialDone = true; if (pos.entry) pos.stop = Math.max(pos.stop ?? 0, pos.entry); }
    admin.addTrade("spot", { side: "sell", symbol: sym, mint, amount_usd: proceeds, price: pos?.live?.price ?? 0, pnl_usd: pnl, reason: "prise de bénéfices partielle", signature: p.sig, source: pos?.source,
      detail: { pourquoi: `le prix a atteint +${String(PARTIAL.atR).replace(".", ",")} fois le risque initial : la moitié est vendue, le stop du reste remonte au prix d'entrée`, entree: pos?.entry, duree_h: pos?.openedAt ? Math.round((Date.now() - pos.openedAt) / 360_000) / 10 : null, coffre: mem.vault } });
    return `Prise de bénéfices partielle ${sym} : ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)} $ sécurisés, le reste ne peut plus perdre (stop au prix d'entrée).`;
  }

  // vente complète
  if (held) { if (st !== "failed") mem.jitoMissAt = Date.now(); return `Vente ${sym} non exécutée (${st}) : je réessaie (par la voie normale).`; }
  if (p.expectedUsd && proceeds < p.expectedUsd * (1 - FILL_ALERT)) fillAlert("vente", (1 - proceeds / p.expectedUsd) * 100);
  const cost = pos?.costUsd ?? proceeds;
  const pnl = proceeds - cost;
  const pnlPct = cost > 0 ? (pnl / cost) * 100 : 0;
  mem.vault = addToVault(mem.vault, pnl, cfg.vaultPct);
  admin.addTrade("spot", {
    side: "sell", symbol: sym, mint, amount_usd: proceeds, price: pos?.live?.price ?? (pos?.entry ?? 0) * (1 + pnlPct / 100), pnl_usd: pnl, reason: p.reason ?? "sortie", signature: p.sig, source: pos?.source,
    detail: { pourquoi: label(p.reason), entree: pos?.entry, stop: pos?.stop, strategie: pos?.source, duree_h: pos?.openedAt ? Math.round((Date.now() - pos.openedAt) / 360_000) / 10 : null, entree_pourquoi: pos?.why, coffre: mem.vault },
  });
  const brain = mem.brain ?? newBrain(valueBefore);
  learn(brain, sym, pnlPct, valueBefore + pnl, Date.now());
  if (pnl < 0) mem.cooldownUntil = Date.now() + cooldownMs(pos?.posInterval);
  delete positions[mint];
  if (mem.signal?.startsWith(`${sym} `)) mem.signal = undefined; // analyse liée à la position vendue : périmée
  return `Vente ${sym} confirmée (${label(p.reason)}) : ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)} $ (${pnlPct.toFixed(1)} %), frais inclus.${pnl > 0 && cfg.vaultPct ? ` ${cfg.vaultPct} % du gain mis au coffre.` : ""}`;
}

/** Vend tout et termine la mission. */
export async function liquidate(admin: Admin, bot: BotRow, outcome: "success" | "destroyed" | "stopped", message: string) {
  const { address, keyPair } = await loadKeyPairFrom(WALLET_ENV);
  const mem = loadMemory(bot.price_history);
  const positions = migratePositions(mem, bot);
  let b = await getBalances(address);
  const prices = await getPrices(allMints()).catch(() => ({} as Record<string, number>));
  const failures: string[] = [];
  for (const t of allTokens()) {
    if (t.mint === SOL_MINT || !holds(b, t.mint, prices)) continue;
    try {
      const usdcBefore = b.usdc;
      const { sig } = await sell(t.mint, b.raw[t.mint] ?? 0n, address, keyPair, false); // fin de mission : voie normale, rapide
      const st = await waitForTx(sig, 25_000);
      if (st !== "confirmed") throw new Error(`transaction ${st}`);
      b = await getBalances(address);
      const proceeds = b.usdc - usdcBefore;
      const cost = positions[t.mint]?.costUsd ?? proceeds;
      admin.addTrade("spot", { side: "sell", symbol: t.symbol, mint: t.mint, amount_usd: proceeds, price: prices[t.mint] ?? 0, pnl_usd: proceeds - cost, reason: outcome, signature: sig,
        source: positions[t.mint]?.source, detail: { pourquoi: message } });
      delete positions[t.mint];
    } catch (e) {
      failures.push(`${t.symbol} : ${(e as Error).message}`);
    }
  }
  const finalValue = portfolio(b, prices, b.sol).value;
  admin.update("spot", {
    status: failures.length ? "running" : outcome, // si une vente échoue, le bot continue de gérer la position au lieu de l'abandonner
    ...mirror(positions), price_history: mem as never, last_value_usd: finalValue, last_tick_at: new Date().toISOString(),
    last_message: (failures.length ? `${message} Vente impossible (${failures.join(", ")}) : je garde la main et je réessaie.` : message).slice(0, 300),
  });
}

// ------------------------------------------------------------------------------------------------
/** Colonnes « position » de la base = première position (pour l'app et l'agent swap). */
function mirror(positions: Record<string, Position>): Partial<BotRow> {
  const first = Object.values(positions)[0];
  return { position_mint: first?.key ?? null, entry_price: first?.entry ?? null };
}
async function save(admin: Admin, mem: Memory, fields: Partial<BotRow>) {
  admin.update("spot", { price_history: mem, last_tick_at: new Date().toISOString(), ...fields });
}
const fmt = (n: number) => (n >= 1 ? n.toFixed(n >= 100 ? 2 : 4) : n.toPrecision(4));
function label(reason?: string) {
  return reason === "rsi_exit" ? "RSI repassé au-dessus du seuil de sortie" : reason === "trailing_stop" ? "stop suiveur, gain protégé" : reason === "stop_loss" ? "stop loss"
    : reason === "time_stop" ? "position sans élan" : reason === "prise_partielle" ? "prise de bénéfices partielle"
    : reason === "objectif" ? "objectif atteint" : reason === "orb_temps" ? "ORB : objectif non atteint à temps" : reason === "vwap_atteint" ? "retour au prix moyen du jour (VWAP) atteint"
    : reason === "nouveau_temps" ? "nouveau token : délai de 4 h écoulé" : reason === "vwap_temps" ? "VWAP : fin de journée sans retour" : reason === "liquidite_effondree" ? "sortie d'urgence : la liquidité du token s'est effondrée"
    : reason === "prise_totale" ? "prise de bénéfices (position trop petite pour être coupée en deux)" : reason ?? "sortie";
}
export type { TradeRow };

/** CHIEN DE GARDE : une erreur qui se répète (5 minutes de suite, puis toutes les heures) déclenche une alerte sur le téléphone. */
function errStreak(admin: Admin, mem: Memory, who: string, msg: string) {
  mem.errStreak = (mem.errStreak ?? 0) + 1;
  if (mem.errStreak === 5 || mem.errStreak % 60 === 0) admin.alert?.(`${who} : la même panne se répète depuis ${mem.errStreak} minutes (${msg.slice(0, 120)}). Les positions restent protégées par leurs stops ; vérifie l'app.`);
}
