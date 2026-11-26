// Serveur uniquement : BOT 2 — perps Jupiter sur SOL, long ET short, en suivi de tendance.
// Le levier n'est plus « x10 tout risquer » : il découle du risque (1,5 % du capital au stop), plafonné à x3.
import type { BotState, Store } from "../store.ts";
import { isBenched, learn, mindset, newBrain, optimize, riskPerTrade } from "./brain.ts";
import { candles as getCandles, hourlyCandles, lastClosedCandle } from "./candles.ts";
import { perpsClose, perpsOpen, perpsPositions, perpsPrice, type PerpPosition } from "./jupiter.ts";
import { getBalances, loadKeyPairFrom, type Balances } from "./solana.ts";
import {
  AGGRESSIVE, atr, dayKey, exitCheck, loadMemory, loadPerpsConfig, missionEnd, PERPS_ASSETS, PERPS_RULES, perpsChange, perpsSizing, PRESETS, RISK, riskFactor, sideMult,
  riskGate, RULES, trailStop, trendSignal, DEFAULT_PARAMS, type Interval, type Memory, type Params,
} from "./strategy.ts";

type Admin = Store;
type PerpsRow = BotState;

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

export async function runPerpsTick(admin: Admin): Promise<string> {
  const bot = admin.bot("perps");
  // En pause : plus aucune entrée, mais une position ouverte reste gérée (stop suiveur).
  const paused = bot.status === "paused";
  if (!(bot.status === "running" || (paused && (bot.position_side || loadMemory(bot.price_history).pending)))) return "idle";
  const now = Date.now();
  const mem: Memory = loadMemory(bot.price_history);
  const cfg = loadPerpsConfig(bot.config);
  const aggressive = cfg.mode === "agressif" && !cfg.autopilot; // prudence : le pilote automatique ne trade jamais en mode agressif
  const maxLev = aggressive ? AGGRESSIVE.maxLeverage : PERPS_RULES.maxLeverage;
  const patch: Partial<PerpsRow> = {};

  // 1. Données : prix, soldes ET positions réelles. Sinon on ne touche à rien (le stop on-chain protège).
  let address: string, keyPair: Awaited<ReturnType<typeof loadKeyPairFrom>>["keyPair"];
  let price: number, solPrice: number, b: Balances, positions: PerpPosition[];
  // Marché du tick : celui de la position ouverte, sinon celui du plan du chercheur, sinon SOL.
  let ASSET: (typeof PERPS_ASSETS)[number] = SOL;
  try {
    ({ address, keyPair } = await loadKeyPairFrom(WALLET_ENV));
    [solPrice, b, positions] = await Promise.all([perpsPrice(SOL.mint), getBalances(address), perpsPositions(address)]);
    const held = positions.find((p) => assetOf(p.asset));
    ASSET = assetOf(held?.asset) ?? assetOf(mem.asset) ?? assetOf(bot.position_asset) ?? assetOf(cfg.plan?.asset) ?? SOL;
    price = ASSET.asset === SOL.asset ? solPrice : await perpsPrice(ASSET.mint);
  } catch (e) {
    await save(admin, bot, mem, { last_message: `Données indisponibles (${(e as Error).message.slice(0, 80)}). Le stop on-chain protège la position, je réessaie.` });
    return "data_unavailable";
  }
  const value = perpsValue(b, solPrice, positions);
  patch.wallet_address = address;
  mem.brain = mem.brain ?? newBrain(value);
  const brain = mem.brain;
  let open = positions.find((p) => p.asset === ASSET.asset) ?? null;
  let message = "";

  // 2. Réconciliation avec la blockchain (ordres différés, stop on-chain déclenché, redémarrage…).
  if (mem.pending) {
    const age = now - mem.pending.at;
    if (mem.pending.kind === "open") {
      if (open) {
        Object.assign(patch, { position_pubkey: open.pubkey, position_asset: open.asset, position_side: open.side, entry_price: open.entryPrice });
        mem.initialRisk = Math.abs(open.entryPrice - (mem.stop ?? open.entryPrice));
        mem.best = open.entryPrice;
        admin.addTrade("perps", { action: "open", asset: open.asset, side: open.side, collateral_usd: open.valueUsd, price: open.entryPrice, reason: mem.signal ?? "tendance", signature: mem.pending.sig, source: mem.source });
        message = `${open.side === "long" ? "Long" : "Short"} ${open.asset} ouvert à ${open.entryPrice.toFixed(2)} $, stop ${mem.stop?.toFixed(2)} $.`;
        mem.pending = undefined;
      } else if (age > PENDING_MS) {
        message = "Ordre d'ouverture non exécuté par Jupiter : annulé, fonds intacts."; clearPosition(mem); mem.pending = undefined;
      } else { await save(admin, bot, mem, { last_value_usd: value, last_message: "Ouverture en cours d'exécution…" }); return "pending"; }
    } else if (mem.pending.kind === "close") {
      if (!open) { message = await recordClose(admin, bot, mem, patch, value, price, mem.pending.reason ?? "sortie", mem.pending.sig, ASSET.asset); mem.pending = undefined; }
      else if (age > PENDING_MS) { message = "Fermeture non exécutée : je réessaie."; mem.pending = undefined; }
      else { await save(admin, bot, mem, { last_value_usd: value, last_message: "Fermeture en cours d'exécution…" }); return "pending"; }
    }
  }
  if (!mem.pending && bot.position_side && !open && patch.position_side === undefined) {
    message = await recordClose(admin, bot, mem, patch, value, price, "stop_onchain", null, ASSET.asset); // stop on-chain déclenché
  }
  if (open && !bot.position_side && patch.position_side === undefined) {
    Object.assign(patch, { position_pubkey: open.pubkey, position_asset: open.asset, position_side: open.side, entry_price: open.entryPrice });
    const fallback = open.side === "long" ? open.entryPrice * 0.96 : open.entryPrice * 1.04;
    Object.assign(mem, { stop: mem.stop ?? fallback, best: open.entryPrice, initialRisk: Math.abs(open.entryPrice - (mem.stop ?? fallback)), openedAt: now, openValueUsd: value, side: open.side, asset: open.asset });
    message = `Position ${open.side} ${open.asset} trouvée : je reprends sa gestion.`;
  }

  // 3. Fin de mission (données complètes uniquement).
  const end = missionEnd({ now, endAt: RULES.destroyAtDeadline && bot.end_at ? Date.parse(bot.end_at) : Infinity,
    goalUsd: Number(bot.goal_usd), valueUsd: value, floorUsd: PERPS_RULES.floorUsd, complete: true });
  if (end && !paused) {
    const outcome = end === "success" ? "success" : end === "destroyed" ? "destroyed" : "stopped";
    await save(admin, bot, mem, { ...patch, last_value_usd: value });
    await liquidatePerps(admin, { ...bot, ...patch } as PerpsRow, outcome,
      end === "success" ? "Mission réussie ! Objectif atteint, gains sécurisés." : end === "destroyed" ? "Date limite atteinte." : `Capital sous ${PERPS_RULES.floorUsd} $ : je protège ce qui reste.`);
    return outcome;
  }

  try {
    const plan = cfg.plan && cfg.plan.asset === ASSET.asset ? cfg.plan : null;
    const params: Params = open && mem.posParams ? (mem.posParams as Params)
      : plan ? plan.params : cfg.trend ?? PRESETS[brain.preset[ASSET.asset] ?? "standard"] ?? DEFAULT_PARAMS;
    const iv: Interval = open ? mem.posInterval ?? "1h" : plan?.interval ?? "1h";
    const closed = lastClosedCandle(now, iv);

    // 4. Position ouverte : stop suiveur à chaque bougie, sortie vérifiée chaque minute.
    if (open) {
      if (mem.stopCandle !== closed) {
        const candles = await getCandles(ASSET.candles, iv, 40, now).catch(() => []);
        if (candles.length > 20) {
          const c = candles.at(-1)!.c;
          mem.best = open.side === "long" ? Math.max(mem.best ?? open.entryPrice, c) : Math.min(mem.best ?? open.entryPrice, c);
          mem.stop = trailStop(open.side, mem.stop ?? open.entryPrice, mem.best, atr(candles, 14).at(-1)!, params);
          mem.stopCandle = closed;
        }
      }
      const stop = mem.stop!;
      const exit = exitCheck({ side: open.side, entry: open.entryPrice, price, stop, initialRisk: mem.initialRisk ?? open.entryPrice * 0.03, openedAt: mem.openedAt ?? now }, now);
      if (exit) {
        const sig = await perpsClose(open.pubkey, PERPS_RULES.slippageBps * 2, keyPair);
        mem.pending = { kind: "close", sig, at: now, reason: exit };
        await save(admin, bot, mem, { ...patch, last_value_usd: value, last_message: `Fermeture ${open.side} ${open.asset} demandée (${label(exit)})…` });
        return "close";
      }
      const move = perpsChange(open.side, open.entryPrice, price) * 100;
      mem.live = { price, pnlPct: move, at: now };
      mem.mindset = mindset(brain, { inPosition: true, blocked: null, goalPct: (value / Number(bot.goal_usd)) * 100 });
      await save(admin, bot, mem, { ...patch, last_value_usd: value,
        last_message: message || `En ${open.side} ${open.asset} : ${move >= 0 ? "+" : ""}${move.toFixed(2)} % du cours, stop suiveur à ${stop.toFixed(2)} $.` });
      return "hold";
    }

    if (paused) {
      await save(admin, bot, mem, { ...patch, last_value_usd: value, last_message: message || "En pause : aucune nouvelle entrée." });
      return "paused";
    }
    // 5. Pas de position : apprentissage quotidien, puis analyse de chaque nouvelle bougie.
    if (cfg.autopilot && !plan) {
      await save(admin, bot, mem, { ...patch, last_value_usd: value, last_message: message || "Pilote automatique : j'attends que le chercheur valide une stratégie perps." });
      return "hold";
    }
    const today = dayKey(now);
    if (!plan && brain.optimized?.[ASSET.asset] !== today) {
      const hist = await hourlyCandles(ASSET.candles, 1440, now).catch(() => null);
      if (hist && hist.length > 500) optimize(brain, ASSET.asset, hist, { allowShort: true, feePct: PERPS_COST, hourlyCost: BORROW_PER_HOUR, leverageCap: maxLev }, today);
      else brain.optimized = { ...brain.optimized, [ASSET.asset]: today };
    }
    // Mode agressif : il trade même quand aucun réglage n'a été validé sur 60 jours, mais respecte toujours la perte max du jour
    // et la mise sur le banc après une série de pertes.
    const benched = aggressive || cfg.trend || plan ? (brain.benched[ASSET.asset] ?? 0) > now : isBenched(brain, ASSET.asset, now);
    const blocked = riskGate(mem, value, now, aggressive ? AGGRESSIVE.dailyLoss : RISK.dailyLoss)
      ?? (benched ? ((!aggressive && !plan && brain.disabled[ASSET.asset]) || `${ASSET.asset} sur le banc après une série difficile`) : null);
    if (blocked || mem.lastCandle === closed) {
      mem.mindset = mindset(brain, { inPosition: false, blocked, goalPct: (value / Number(bot.goal_usd)) * 100 });
      await save(admin, bot, mem, { ...patch, last_value_usd: value, last_message: message || blocked || mem.signal || "En attente de la prochaine bougie." });
      return "hold";
    }
    mem.lastCandle = closed;
    const candles = await getCandles(ASSET.candles, iv, 400, now);
    const sig = trendSignal(candles, sideMult(cfg.bias, "short") > 0, params);
    mem.signal = `${ASSET.asset} : ${sig.reason}`;
    const mult = sig.side ? sideMult(cfg.bias, sig.side) : 0;
    if (sig.side && mult === 0) {
      await save(admin, bot, mem, { ...patch, last_value_usd: value, last_message: message || `Signal ${sig.side} ignoré : les ${sig.side === "long" ? "longs" : "shorts"} sont désactivés par ta barre longs/shorts.` });
      return "hold";
    }
    if (!sig.side) {
      mem.mindset = mindset(brain, { inPosition: false, blocked: null, goalPct: (value / Number(bot.goal_usd)) * 100 });
      await save(admin, bot, mem, { ...patch, last_value_usd: value, last_message: message || `Pas d'entrée : ${sig.reason}.` });
      return "hold";
    }
    // le stop reste à la même distance que sur la bougie, recalé sur le prix réel
    const dist = Math.abs(sig.price - sig.stop);
    const stop = sig.side === "long" ? price - dist : price + dist;
    const baseRisk = aggressive ? Math.min(AGGRESSIVE.maxRisk, riskPerTrade(brain) * AGGRESSIVE.riskMult) : riskPerTrade(brain);
    const confidence = plan ? riskFactor(plan.confidence) : 1; // stratégie du chercheur pas encore confirmée en réel : 75 % du risque
    const size = perpsSizing(value, b.usdc, price, stop, baseRisk * mult * confidence, maxLev);
    if (!size) {
      await save(admin, bot, mem, { ...patch, last_value_usd: value, last_message: `Signal ${sig.side} mais capital insuffisant pour respecter le risque (min ${PERPS_RULES.minCollateralUsd} $ de collatéral).` });
      return "hold";
    }
    const txid = await perpsOpen({ wallet: address, asset: ASSET.asset, side: sig.side, usdcRaw: BigInt(Math.floor(size.collateral * 1e6)),
      leverage: size.leverage, stop, slippageBps: PERPS_RULES.slippageBps }, keyPair);
    Object.assign(mem, { pending: { kind: "open", sig: txid, at: now }, stop, best: price, initialRisk: dist, openedAt: now, openValueUsd: value, side: sig.side, asset: ASSET.asset, stopCandle: closed,
      posParams: params, posInterval: iv, source: plan?.source ?? cfg.source ?? "réglages de l'app" });
    await save(admin, bot, mem, { ...patch, last_value_usd: value,
      last_message: `${sig.side === "long" ? "Long" : "Short"} ${ASSET.asset} demandé${aggressive ? " (mode agressif)" : ""} : ${size.collateral.toFixed(2)} $ x${size.leverage.toFixed(1)}, risque ${(baseRisk * mult * confidence * 100).toFixed(1)} %, stop ${stop.toFixed(2)} $ (${sig.reason}).` });
    return "open";
  } catch (e) {
    await save(admin, bot, mem, { ...patch, last_value_usd: value, last_message: `Erreur : ${(e as Error).message}`.slice(0, 300) + " — je réessaie au prochain tick." });
    return "error";
  }
}

/** PnL RÉEL = valeur du portefeuille maintenant − valeur juste avant l'ouverture (frais et portage inclus). */
async function recordClose(admin: Admin, bot: PerpsRow, mem: Memory, patch: Partial<PerpsRow>, value: number, price: number, reason: string, sig: string | null, asset: string) {
  const before = mem.openValueUsd ?? value;
  const pnl = value - before;
  const pnlPct = before > 0 ? (pnl / before) * 100 : 0;
  admin.addTrade("perps", { action: "close", asset: bot.position_asset ?? asset, side: bot.position_side, collateral_usd: value, price, pnl_usd: pnl, reason, signature: sig, source: mem.source });
  const brain = mem.brain ?? newBrain(value);
  learn(brain, asset, pnlPct, value, Date.now());
  if (pnl < 0) mem.cooldownUntil = Date.now() + RISK.cooldownAfterLossMs;
  clearPosition(mem);
  Object.assign(patch, { position_pubkey: null, position_asset: null, position_side: null, entry_price: null });
  return `Position fermée (${label(reason)}) : ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)} $ (${pnlPct.toFixed(1)} % du capital).`;
}

export async function liquidatePerps(admin: Admin, bot: PerpsRow, outcome: "success" | "destroyed" | "stopped", message: string) {
  const { address, keyPair } = await loadKeyPairFrom(WALLET_ENV);
  const positions = await perpsPositions(address);
  const failures: string[] = [];
  for (const p of positions) {
    try {
      const sig = await perpsClose(p.pubkey, PERPS_RULES.slippageBps * 2, keyPair);
      admin.addTrade("perps", { action: "close", asset: p.asset, side: p.side, collateral_usd: p.valueUsd, reason: outcome, signature: sig });
    } catch (e) { failures.push((e as Error).message); }
  }
  const mem = loadMemory(bot.price_history);
  clearPosition(mem);
  admin.update("perps", {
    status: failures.length ? "running" : outcome, price_history: mem as never, last_tick_at: new Date().toISOString(),
    last_message: (failures.length ? `${message} Fermeture impossible (${failures.join(", ")}) : je garde la main.` : message).slice(0, 300),
    ...(failures.length ? {} : { position_pubkey: null, position_asset: null, position_side: null, entry_price: null }),
  });
}

function clearPosition(mem: Memory) {
  for (const k of ["stop", "best", "initialRisk", "openedAt", "openValueUsd", "asset", "side", "stopCandle", "live", "posParams", "posInterval", "source"] as const) delete mem[k];
}
async function save(admin: Admin, bot: PerpsRow, mem: Memory, fields: Partial<PerpsRow>) {
  void bot;
  admin.update("perps", { price_history: mem, last_tick_at: new Date().toISOString(), ...fields });
}
function label(reason?: string) {
  return reason === "trailing_stop" ? "stop suiveur, gain protégé" : reason === "stop_loss" ? "stop loss" : reason === "time_stop" ? "position sans élan" : reason === "stop_onchain" ? "stop de sécurité on-chain" : reason ?? "sortie";
}
