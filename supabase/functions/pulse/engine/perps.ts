// Serveur uniquement : BOT 2 — perps Jupiter, long ET short. Une position par marché (SOL, ETH, BTC), risque total plafonné.
// Le levier découle du risque, plafonné par le levier choisi ET par la distance du stop (jamais de liquidation avant le stop).
import type { BotState, Store } from "../store.ts";
import { isBenched, learn, mindset, newBrain, optimize, riskPerTrade } from "./brain.ts";
import { candles as getCandles, hourlyCandles, lastClosedCandle } from "./candles.ts";
import { perpsClose, perpsOpen, perpsPositions, perpsPrice, type PerpPosition } from "./jupiter.ts";
import { getBalances, loadKeyPairFrom, type Balances } from "./solana.ts";
import { fundingHistory } from "./funding.ts";
import { isSetup, setupExit, setupSignal, trailParams, TRAILING, type Extra, type SetupParams } from "./setups.ts";
import {
  addToVault, applyTransfer, detectTransfer, AGGR_AGGRESSIVE, AGGR_LEVELS, effectiveAggr, atr, dayKey, exitCheck, loadMemory, loadPerpsConfig, migratePositions, missionEnd, PARTIAL, PERPS_ASSETS, PERPS_RULES,
  perpsChange, perpsSizing, PRESETS, RISK, riskFactor, cooldownMs, floorOf, solReserveAlert, volScale, sampleCurve, sideMult, riskGate, RULES, TOTAL_RISK, tradable, trailStop, trendSignal, DEFAULT_PARAMS,
  type Interval, type Memory, type Params, type PerpsConfig, type PerpsPlan, type Position,
} from "./strategy.ts";

type Admin = Store;
type PerpsRow = BotState;
type KeyPair = Awaited<ReturnType<typeof loadKeyPairFrom>>["keyPair"];
type Asset = (typeof PERPS_ASSETS)[number];

const WALLET_ENV = "PERPS_WALLET_PRIVATE_KEY";
const SOL = PERPS_ASSETS[0];
const assetOf = (name: string | null | undefined) => PERPS_ASSETS.find((a) => a.asset === name);
const PERPS_COST = 0.0012;        // frais ouverture/fermeture + slippage, par côté (backtest)
const BORROW_PER_HOUR = 0.00008;  // coût de portage estimé (backtest)
const PENDING_MS = 5 * 60_000;    // les keepers Jupiter exécutent les ordres en différé

export async function getPerpsWalletAddress(): Promise<string | null> {
  try { return (await loadKeyPairFrom(WALLET_ENV)).address; } catch { return null; }
}

export function perpsValue(b: Balances, solPrice: number, positions: PerpPosition[]) {
  return b.usdc + b.sol * solPrice + positions.reduce((s, p) => s + p.valueUsd, 0);
}

export async function currentPerpsValue() {
  const { address } = await loadKeyPairFrom(WALLET_ENV);
  const [price, b, positions] = await Promise.all([perpsPrice(SOL.mint), getBalances(address), perpsPositions(address)]);
  return { address, valueUsd: perpsValue(b, price, positions), positions };
}

/** Perte si le stop de chaque position est touché, en part du capital. */
function openRisk(positions: Position[], valueUsd: number) {
  if (!(valueUsd > 0)) return 0;
  return positions.reduce((s, p) => {
    const price = p.live?.price ?? p.entry ?? 0, stop = p.stop ?? price;
    if (!(price > 0)) return s;
    const adverse = p.side === "long" ? price - stop : stop - price;
    return s + Math.max(0, adverse / price) * (p.sizeUsd ?? 0);
  }, 0) / valueUsd;
}

export async function runPerpsTick(admin: Admin): Promise<string> {
  const bot = admin.bot("perps");
  const mem: Memory = loadMemory(bot.price_history);
  const mine = migratePositions(mem, bot);
  // En pause : plus aucune entrée, mais les positions ouvertes restent gérées (stop suiveur).
  const paused = bot.status === "paused";
  // En pause sans position : on relit quand même le portefeuille (valeur à jour, dépôts et retraits détectés).
  if (!(bot.status === "running" || paused)) return "idle";
  const now = Date.now();
  const cfg = loadPerpsConfig(bot.config);
  // Agressivité choisie dans l'app (plafonnée à « Normal » en pilote automatique, sauf mode agressif des agents)
  const level = effectiveAggr(cfg), L = AGGR_LEVELS[level]!;
  const aggressive = level >= AGGR_AGGRESSIVE;
  const patch: Partial<PerpsRow> = {};
  const hadPending = !!mem.pending; // un ordre en cours change les soldes : pas de détection de transfert ce tick

  // 1. Données : prix, soldes ET positions réelles. Sinon on ne touche à rien (le stop on-chain protège).
  let address: string, keyPair: KeyPair, solPrice: number, b: Balances, real: PerpPosition[];
  try {
    ({ address, keyPair } = await loadKeyPairFrom(WALLET_ENV));
    [solPrice, b, real] = await Promise.all([perpsPrice(SOL.mint), getBalances(address), perpsPositions(address)]);
  } catch (e) {
    errStreak(admin, mem, "Bot perps", (e as Error).message);
    await save(admin, mem, { last_message: `Données indisponibles (${(e as Error).message.slice(0, 80)}). Le stop on-chain protège les positions, je réessaie.` });
    return "data_unavailable";
  }
  const prevErr = mem.errStreak ?? 0;
  mem.errStreak = 0;
  const prices: Record<string, number> = { SOL: solPrice };
  const priceOf = async (a: Asset) => (prices[a.asset] ??= await perpsPrice(a.mint));
  const value = perpsValue(b, solPrice, real);
  patch.wallet_address = address;
  mem.brain = mem.brain ?? newBrain(value);
  const brain = mem.brain;
  const realOf = (asset: string) => real.find((p) => p.asset === asset) ?? null;
  let message = "";

  // 2. Ordre en attente (les keepers Jupiter exécutent en différé).
  if (mem.pending) {
    const pd = mem.pending, asset = pd.asset ?? pd.draft?.key ?? "", open = realOf(asset), age = now - pd.at;
    if (pd.kind === "open") {
      if (open) {
        const d = pd.draft ?? { key: asset, symbol: asset, side: open.side };
        mine[asset] = { ...d, key: asset, symbol: asset, side: open.side, entry: open.entryPrice, pubkey: open.pubkey, best: open.entryPrice, initialRisk: Math.abs(open.entryPrice - (d.stop ?? open.entryPrice)),
          collateralUsd: d.collateralUsd ?? open.valueUsd, sizeUsd: open.sizeUsd, lastValueUsd: open.valueUsd };
        admin.addTrade("perps", { action: "open", asset, side: open.side, collateral_usd: open.valueUsd, price: open.entryPrice, reason: mem.signal ?? "tendance", signature: pd.sig, source: d.source,
          detail: { pourquoi: d.why, stop: d.stop, strategie: d.source, levier: open.sizeUsd && d.collateralUsd ? Math.round((open.sizeUsd / d.collateralUsd) * 10) / 10 : null } });
        message = `${open.side === "long" ? "Long" : "Short"} ${asset} ouvert à ${open.entryPrice.toFixed(2)} $, stop ${d.stop?.toFixed(2)} $.`;
        mem.pending = undefined;
      } else if (age > PENDING_MS) { message = `Ordre d'ouverture ${asset} non exécuté par Jupiter : annulé, fonds intacts.`; mem.pending = undefined; }
      else { await save(admin, mem, { ...mirror(mine), last_value_usd: value, last_message: `Ouverture ${asset} en cours d'exécution…` }); return "pending"; }
    } else if (pd.kind === "close") {
      if (!open) { message = recordClose(admin, mem, cfg, asset, value, b.usdc - (pd.usdcBefore ?? b.usdc), pd.reason ?? "sortie", pd.sig); mem.pending = undefined; }
      else if (age > PENDING_MS) { message = `Fermeture ${asset} non exécutée : je réessaie.`; mem.pending = undefined; }
      else { await save(admin, mem, { ...mirror(mine), last_value_usd: value, last_message: `Fermeture ${asset} en cours d'exécution…` }); return "pending"; }
    }
  }

  // 3. Réconciliation avec la blockchain : stop on-chain déclenché, ou position trouvée sans mémoire.
  const back = b.usdc - (mem.lastUsdc ?? b.usdc); // USDC revenus depuis le tick précédent
  const gone: Position[] = [];
  for (const p of Object.values(mine)) {
    if (realOf(p.key) || mem.pending?.asset === p.key) { p.missing = 0; continue; }
    // fermée pour de bon seulement si l'argent est revenu, ou si elle reste introuvable 2 minutes de suite
    // (une réponse vide isolée de l'API ne doit pas faire oublier la position et son stop)
    p.missing = (p.missing ?? 0) + 1;
    if (back > 0.5 || p.missing >= 2) gone.push(p);
  }
  for (const p of gone) // une seule position fermée : on connaît exactement les USDC revenus ; sinon dernière valeur vue
    message = recordClose(admin, mem, cfg, p.key, value, gone.length === 1 && back > 0 ? back : p.lastValueUsd ?? 0, "stop_onchain", null);
  for (const o of real) {
    if (!assetOf(o.asset) || mine[o.asset] || mem.pending?.asset === o.asset) continue;
    const fallback = o.side === "long" ? o.entryPrice * 0.96 : o.entryPrice * 1.04;
    mine[o.asset] = { key: o.asset, symbol: o.asset, side: o.side, entry: o.entryPrice, stop: fallback, best: o.entryPrice, initialRisk: Math.abs(o.entryPrice - fallback), openedAt: now,
      pubkey: o.pubkey, collateralUsd: o.valueUsd, sizeUsd: o.sizeUsd, lastValueUsd: o.valueUsd, source: "position trouvée sur Jupiter", why: "reprise d'une position existante (stop de sécurité ±4 %)" };
    message = `Position ${o.side} ${o.asset} trouvée : je reprends sa gestion.`;
  }
  for (const p of Object.values(mine)) { const o = realOf(p.key); if (o) { p.lastValueUsd = o.valueUsd; p.sizeUsd = o.sizeUsd; p.pubkey = o.pubkey; } }
  // Dépôt ou retrait (USDC/SOL arrivés ou partis sans trade) : ce n'est ni un gain ni une perte.
  // Prudence : des USDC qui arrivent pendant qu'une position est ouverte peuvent être son stop on-chain pas encore visible
  // dans l'API ; si le montant ressemble à la valeur d'une position, on attend la minute suivante pour trancher.
  let rebase = true;
  if (!hadPending && !gone.length) {
    const d = detectTransfer(mem, b.usdc, b.sol, solPrice, value);
    const looksLikeStop = d > 0 && Object.values(mine).some((p) => Math.abs(d - (p.lastValueUsd ?? 0)) < 0.2 * (p.lastValueUsd ?? 0) + 0.5);
    if (looksLikeStop) rebase = false;
    else if (d) {
      if (bot.start_value_usd != null) patch.start_value_usd = Math.max(0.01, Number(bot.start_value_usd) + d);
      applyTransfer(mem, d);
      admin.addTrade("perps", { action: d > 0 ? "deposit" : "withdraw", asset: "USDC", collateral_usd: Math.abs(d), reason: d > 0 ? "dépôt" : "retrait",
        detail: { pourquoi: `${d > 0 ? "Dépôt" : "Retrait"} de ${Math.abs(d).toFixed(2)} $ détecté (aucun ordre en cours) : point de départ, perte du jour et courbe ajustés, ce n'est ni un gain ni une perte.` } });
      message = `${d > 0 ? "Dépôt" : "Retrait"} de ${Math.abs(d).toFixed(2)} $ détecté : compteurs ajustés (ni gain ni perte).`;
    }
  }
  sampleCurve(mem, value, now);
  const solAlert = solReserveAlert(mem, b.sol, now, "Bot perps");
  if (solAlert) { admin.alert?.(solAlert); message ||= solAlert; }
  if (rebase) { mem.lastUsdc = b.usdc; mem.lastSol = b.sol; }

  // 4. Fin de mission (données complètes uniquement).
  const end = missionEnd({ now, endAt: RULES.destroyAtDeadline && bot.end_at ? Date.parse(bot.end_at) : Infinity,
    goalUsd: Number(bot.goal_usd), valueUsd: value, floorUsd: floorOf(bot.start_value_usd, PERPS_RULES.floorUsd), complete: true });
  if (end && !paused) {
    const outcome = end === "success" ? "success" : end === "destroyed" ? "destroyed" : "stopped";
    await save(admin, mem, { ...patch, ...mirror(mine), last_value_usd: value });
    await liquidatePerps(admin, { ...bot, ...patch, price_history: mem } as PerpsRow, outcome,
      end === "success" ? "Mission réussie ! Objectif atteint, gains sécurisés." : end === "destroyed" ? "Date limite atteinte." : `Capital sous ${floorOf(bot.start_value_usd, PERPS_RULES.floorUsd).toFixed(2)} $ (30 % du départ) : je protège ce qui reste.`);
    return outcome;
  }

  try {
    // 5. Positions ouvertes : stop suiveur à chaque bougie, stop au prix d'entrée à +1,5 R, sortie vérifiée chaque minute.
    for (const p of Object.values(mine)) {
      const A = assetOf(p.key), o = realOf(p.key);
      if (!A || !o) continue;
      const price = await priceOf(A);
      const entry = p.entry ?? o.entryPrice;
      const iv: Interval = p.posInterval ?? "1h";
      const closed = lastClosedCandle(now, iv);
      // familles « à objectif » (range, ORB, VWAP, funding) : stop fixe, objectif, sortie jugée à la clôture des bougies ;
      // tendance et familles suiveuses (compression, volume) : stop suiveur
      const fam = p.strategy && isSetup(p.strategy) ? p.strategy : null;
      const isRangePos = !!fam && !TRAILING.includes(fam);
      const params = fam ? trailParams(p.posParams as SetupParams) : (p.posParams as Params | undefined) ?? cfg.trend ?? PRESETS[brain.preset[p.key] ?? "standard"] ?? DEFAULT_PARAMS;
      let rangeOut: string | null = null;
      if (isRangePos && p.stopCandle !== closed) {
        const c = await getCandles(A.candles, iv, 260, now).catch(() => []);
        if (c.length > 40) { rangeOut = setupExit(fam!, c, p.side, p.posParams as SetupParams, Math.round((now - (p.openedAt ?? now)) / (iv === "15m" ? 900_000 : 3_600_000)), p.openedAt ?? now); p.stopCandle = closed; }
      } else if (!isRangePos && p.stopCandle !== closed) {
        const c = await getCandles(A.candles, iv, 40, now).catch(() => []);
        if (c.length > 20) {
          const last = c.at(-1)!.c;
          p.best = p.side === "long" ? Math.max(p.best ?? entry, last) : Math.min(p.best ?? entry, last);
          p.stop = trailStop(p.side, p.stop ?? entry, p.best, atr(c, 14).at(-1)!, params);
          p.stopCandle = closed;
        }
      }
      // Protection des gains : à +1,5 R, le stop passe au prix d'entrée (la position ne peut plus perdre)
      const r = p.initialRisk ? (p.side === "long" ? price - entry : entry - price) / p.initialRisk : 0;
      if (cfg.partialTp && !isRangePos && !p.partialDone && r >= PARTIAL.atR) {
        p.stop = p.side === "long" ? Math.max(p.stop ?? entry, entry) : Math.min(p.stop ?? entry, entry);
        p.partialDone = true;
        message = `${p.key} : gain de +${String(PARTIAL.atR).replace(".", ",")} fois le risque atteint, stop remonté au prix d'entrée.`;
      }
      const move = perpsChange(p.side, entry, price) * 100;
      p.live = { price, pnlPct: move, at: now };
      const hitTarget = p.target != null && (p.side === "long" ? price >= p.target : price <= p.target);
      const exit = isRangePos
        ? ((p.side === "long" ? price <= (p.stop ?? 0) : price >= (p.stop ?? Infinity)) ? "stop_loss" : hitTarget ? "objectif" : rangeOut)
        : exitCheck({ side: p.side, entry, price, stop: p.stop ?? entry, initialRisk: p.initialRisk ?? entry * 0.03, openedAt: p.openedAt ?? now, interval: iv }, now);
      if (exit) {
        const sig = await perpsClose(o.pubkey, PERPS_RULES.slippageBps * 2, keyPair);
        mem.pending = { kind: "close", sig, at: now, asset: p.key, usdcBefore: b.usdc, reason: exit };
        await save(admin, mem, { ...patch, ...mirror(mine), last_value_usd: value, last_message: `Fermeture ${p.side} ${p.key} demandée (${label(exit)})…` });
        return "close";
      }
    }
    const held = Object.values(mine);
    const posText = held.map((p) => `${p.side === "long" ? "long" : "short"} ${p.key} ${p.live ? `${p.live.pnlPct >= 0 ? "+" : ""}${p.live.pnlPct.toFixed(2)} %` : ""}`).join(", ");
    const hold = async (msg: string, blocked: string | null = null) => {
      mem.mindset = mindset(brain, { inPosition: held.length > 0, blocked, goalPct: (value / Number(bot.goal_usd)) * 100 });
      await save(admin, mem, { ...patch, ...mirror(mine), last_value_usd: value, last_message: message || (held.length ? `${msg} · ${posText}` : msg) });
      return "hold";
    };
    if (paused) return await hold("En pause : aucune nouvelle entrée.");

    // 6. Entrées : une par marché. Plans du chercheur (un par marché), sinon SOL avec les réglages du cerveau.
    const plans: (PerpsPlan | null)[] = cfg.autopilot || cfg.plans.length ? cfg.plans : [null];
    if (cfg.autopilot && !cfg.plans.length) return await hold("Pilote automatique : j'attends que le chercheur valide une stratégie perps.");
    if (held.length >= cfg.maxPositions) return await hold(`${held.length} position(s) ouverte(s), maximum atteint`);
    const blocked = riskGate(mem, value, now, L.dailyLoss);
    if (blocked) return await hold(blocked, blocked);
    const notes: string[] = [];
    for (const plan of plans) {
      const A = plan ? assetOf(plan.asset) : SOL;
      if (!A || mine[A.asset] || mem.pending) continue;
      const setup = plan?.family && isSetup(plan.family) ? plan.family : null;
      const isRangePlan = !!setup;
      const params = (plan ? plan.params : cfg.trend ?? PRESETS[brain.preset[A.asset] ?? "standard"] ?? DEFAULT_PARAMS) as Params;
      const iv: Interval = plan?.interval ?? "1h";
      const closed = lastClosedCandle(now, iv);
      mem.lastCandleBy ??= {};
      if (mem.lastCandleBy[A.asset] === closed) continue; // chaque bougie n'est analysée qu'une fois
      const today = dayKey(now);
      if (!plan && brain.optimized?.[A.asset] !== today) {
        const hist = await hourlyCandles(A.candles, 1440, now).catch(() => null);
        if (hist && hist.length > 500) optimize(brain, A.asset, hist, { allowShort: true, feePct: PERPS_COST, hourlyCost: BORROW_PER_HOUR, leverageCap: cfg.maxLev }, today);
        else brain.optimized = { ...brain.optimized, [A.asset]: today };
      }
      mem.lastCandleBy[A.asset] = closed;
      // À partir de « Agressif », il trade même sans réglage validé sur 60 jours (mais respecte la mise sur le banc)
      const benched = aggressive || cfg.trend || plan ? (brain.benched[A.asset] ?? 0) > now : isBenched(brain, A.asset, now);
      if (benched) { notes.push((!aggressive && !plan && brain.disabled[A.asset]) || `${A.asset} sur le banc après une série difficile`); continue; }
      const c = await getCandles(A.candles, iv, 400, now);
      const extra: Extra = setup === "funding" ? { funding: await fundingHistory(A.asset, now - 2 * 86_400_000, now).catch(() => []) } : {};
      const sig = setup ? setupSignal(setup, c, sideMult(cfg.bias, "short") > 0, plan!.params as SetupParams, extra) : trendSignal(c, sideMult(cfg.bias, "short") > 0, params);
      mem.signal = `${A.asset} : ${sig.reason}`;
      const mult = sig.side ? sideMult(cfg.bias, sig.side) : 0;
      if (!sig.side || mult === 0) { notes.push(sig.side ? `${A.asset} : ${sig.side} désactivé par ta barre longs/shorts` : `${A.asset} : ${sig.reason}`); continue; }
      const price = await priceOf(A);
      const dist = Math.abs(sig.price - sig.stop);
      const stop = sig.side === "long" ? price - dist : price + dist;
      const confidence = plan ? riskFactor(plan.confidence) : 1; // stratégie du chercheur pas encore confirmée en réel : 75 %
      const vol = volScale(c); // marché agité : risque réduit (les stops sautent plus souvent)
      const wanted = Math.min(L.maxRisk, riskPerTrade(brain) * L.riskMult) * mult * confidence * vol;
      const room = L.maxRisk * TOTAL_RISK.perpsMult - openRisk(held, value); // risque total plafonné
      const risk = Math.min(wanted, room);
      if (risk < 0.002) { notes.push(`${A.asset} : risque total des positions déjà au plafond`); continue; }
      const T = tradable(value, b.usdc, mem.vault);
      const size = perpsSizing(T.equity, T.usdc, price, stop, risk, cfg.maxLev, Math.min(L.maxRisk, room));
      if (!size) { notes.push(`${A.asset} : signal ${sig.side} refusé — capital disponible (hors coffre) trop faible : Jupiter exige ${PERPS_RULES.minCollateralUsd} $ de collatéral, et la position minimale dépasserait ton plafond de risque`); continue; }
      const txid = await perpsOpen({ wallet: address, asset: A.asset, side: sig.side, usdcRaw: BigInt(Math.floor(size.collateral * 1e6)), leverage: size.leverage, stop, slippageBps: PERPS_RULES.slippageBps }, keyPair);
      const source = plan?.source ?? cfg.source ?? "réglages de l'app";
      mem.pending = { kind: "open", sig: txid, at: now, asset: A.asset, draft: {
        key: A.asset, symbol: A.asset, side: sig.side, stop, best: price, initialRisk: dist, openedAt: now, stopCandle: closed, posParams: isRangePlan ? plan!.params : params, posInterval: iv, source,
        ...(setup ? { strategy: setup } : {}), ...("target" in sig && sig.target != null ? { target: (sig.target as number) + (price - sig.price) } : {}),
        collateralUsd: size.collateral, sizeUsd: size.notional,
        why: `${sig.reason} · stratégie : ${source} · ${L.name.toLowerCase()}, risque ${(size.risk * 100).toFixed(1)} %${size.risk > risk * 1.05 ? " (position minimale de Jupiter : 10 $ de collatéral)" : ""}, levier x${size.leverage.toFixed(1)}${vol < 1 ? `, taille réduite (marché agité ×${vol})` : ""}${mem.vault ? ` (coffre de ${mem.vault.toFixed(2)} $ exclu)` : ""}`,
      } };
      await save(admin, mem, { ...patch, ...mirror(mine), last_value_usd: value,
        last_message: `${sig.side === "long" ? "Long" : "Short"} ${A.asset} demandé (${L.name.toLowerCase()}) : ${size.collateral.toFixed(2)} $ x${size.leverage.toFixed(1)}, risque ${(size.risk * 100).toFixed(1)} %, stop ${stop.toFixed(2)} $ (${sig.reason}).` });
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

/** PnL d'une position = USDC revenus − collatéral déposé (frais et portage inclus). Une part du gain va au coffre. */
function recordClose(admin: Admin, mem: Memory, cfg: PerpsConfig, asset: string, value: number, proceeds: number, reason: string, sig: string | null) {
  const p = mem.positions?.[asset];
  const collateral = p?.collateralUsd ?? proceeds;
  const pnl = proceeds - collateral;
  const pnlPct = value > 0 ? (pnl / value) * 100 : 0;
  mem.vault = addToVault(mem.vault, pnl, cfg.vaultPct);
  admin.addTrade("perps", { action: "close", asset, side: p?.side, collateral_usd: proceeds, price: p?.live?.price, pnl_usd: pnl, reason, signature: sig, source: p?.source,
    detail: { pourquoi: label(reason), entree: p?.entry, stop: p?.stop, strategie: p?.source, duree_h: p?.openedAt ? Math.round((Date.now() - p.openedAt) / 360_000) / 10 : null, entree_pourquoi: p?.why, coffre: mem.vault } });
  learn(mem.brain ?? newBrain(value), asset, pnlPct, value, Date.now());
  if (pnl < 0) mem.cooldownUntil = Date.now() + cooldownMs(p?.posInterval);
  if (mem.positions) delete mem.positions[asset];
  return `Position ${asset} fermée (${label(reason)}) : ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)} $ (${pnlPct.toFixed(1)} % du capital).${pnl > 0 && cfg.vaultPct ? ` ${cfg.vaultPct} % du gain mis au coffre.` : ""}`;
}

export async function liquidatePerps(admin: Admin, bot: PerpsRow, outcome: "success" | "destroyed" | "stopped", message: string) {
  const { address, keyPair } = await loadKeyPairFrom(WALLET_ENV);
  const real = await perpsPositions(address);
  const mem = loadMemory(bot.price_history);
  const mine = migratePositions(mem, bot);
  const failures: string[] = [];
  for (const p of real) {
    try {
      const sig = await perpsClose(p.pubkey, PERPS_RULES.slippageBps * 2, keyPair);
      const pnl = mine[p.asset]?.collateralUsd != null ? p.valueUsd - mine[p.asset]!.collateralUsd! : undefined;
      admin.addTrade("perps", { action: "close", asset: p.asset, side: p.side, collateral_usd: p.valueUsd, pnl_usd: pnl, reason: outcome, signature: sig, source: mine[p.asset]?.source, detail: { pourquoi: message } });
      delete mine[p.asset];
    } catch (e) { failures.push((e as Error).message); }
  }
  admin.update("perps", {
    status: failures.length ? "running" : outcome, price_history: mem as never, last_tick_at: new Date().toISOString(), ...mirror(mine),
    last_message: (failures.length ? `${message} Fermeture impossible (${failures.join(", ")}) : je garde la main.` : message).slice(0, 300),
  });
}

/** Colonnes « position » de la base = première position (pour l'app). */
function mirror(mine: Record<string, Position>): Partial<PerpsRow> {
  const p = Object.values(mine)[0];
  return { position_pubkey: p?.pubkey ?? null, position_asset: p?.key ?? null, position_side: p?.side ?? null, entry_price: p?.entry ?? null };
}
async function save(admin: Admin, mem: Memory, fields: Partial<PerpsRow>) {
  admin.update("perps", { price_history: mem, last_tick_at: new Date().toISOString(), ...fields });
}
function label(reason?: string) {
  return reason === "objectif" ? "objectif atteint" : reason === "orb_temps" ? "ORB : objectif non atteint à temps" : reason === "vwap_atteint" ? "retour au prix moyen du jour (VWAP) atteint" : reason === "vwap_temps" ? "VWAP : fin de journée sans retour" : reason === "funding_temps" ? "funding : délai écoulé" : reason === "range_temps" ? "range : pas de retour à la moyenne à temps" : reason === "trailing_stop" ? "stop suiveur, gain protégé" : reason === "stop_loss" ? "stop loss" : reason === "time_stop" ? "position sans élan" : reason === "stop_onchain" ? "stop de sécurité on-chain" : reason ?? "sortie";
}

/** CHIEN DE GARDE : une erreur qui se répète (5 minutes de suite, puis toutes les heures) déclenche une alerte sur le téléphone. */
function errStreak(admin: Admin, mem: Memory, who: string, msg: string) {
  mem.errStreak = (mem.errStreak ?? 0) + 1;
  if (mem.errStreak === 5 || mem.errStreak % 60 === 0) admin.alert?.(`${who} : la même panne se répète depuis ${mem.errStreak} minutes (${msg.slice(0, 120)}). Les positions restent protégées par leurs stops ; vérifie l'app.`);
}
