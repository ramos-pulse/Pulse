// Serveur uniquement : BOT 1 — spot Solana (USDC ⇄ SOL, JUP, BONK, WBTC, WETH) en suivi de tendance.
import type { BotState, Store } from "../store.ts";
import { isBenched, learn, mindset, newBrain, optimize, riskPerTrade } from "./brain.ts";
import { hourlyCandles, lastClosedCandle } from "./candles.ts";
import { executeSwap, getPrices, getQuote } from "./jupiter.ts";
import { getBalances, loadKeyPairFrom, txStatus, waitForTx, type Balances } from "./solana.ts";
import {
  dayKey, exitCheck, loadMemory, missionEnd, PRESETS, RISK, riskGate, RULES, SOL_MINT, spotSizeUsd, TOKENS,
  trailStop, trendSignal, USDC_MINT, atr, type Memory, type Signal,
} from "./strategy.ts";

type Admin = Store;
type BotRow = BotState;
type Token = (typeof TOKENS)[number];

const WALLET_ENV = "BOT_WALLET_PRIVATE_KEY";
const MIN_POSITION_USD = 1.5;    // en dessous : poussière, pas une position
const SPOT_COST = 0.003;         // coût estimé par côté (frais + slippage) pour le backtest
const ALL_MINTS = [USDC_MINT, ...TOKENS.map((t) => t.mint)];
const tokenOf = (mint: string | null | undefined) => TOKENS.find((t) => t.mint === mint);
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
  for (const t of TOKENS) {
    if (t.mint === SOL_MINT) continue;
    const q = b.ui[t.mint] ?? 0;
    if (q <= 0) continue;
    const p = prices[t.mint];
    if (p) value += q * p; else complete = false;
  }
  return { value, complete };
}

export async function currentValue() {
  const { address } = await loadKeyPairFrom(WALLET_ENV);
  const [prices, b] = await Promise.all([getPrices(ALL_MINTS), getBalances(address)]);
  return { address, valueUsd: portfolio(b, prices, b.sol).value };
}

/** Le portefeuille fait foi : détient-on vraiment ce jeton ? */
function holds(b: Balances, mint: string, prices: Record<string, number>): boolean {
  const raw = b.raw[mint] ?? 0n;
  if (raw <= 0n) return false;
  const p = prices[mint];
  return p ? (b.ui[mint] ?? 0) * p >= MIN_POSITION_USD : true;
}

async function sellAll(mint: string, b: Balances, owner: string, keyPair: Parameters<typeof executeSwap>[2]) {
  const amount = b.raw[mint] ?? 0n;
  if (amount <= 0n) throw new Error("rien à vendre");
  const quote = await getQuote(mint, USDC_MINT, amount, RULES.exitSlippageBps);
  return executeSwap(quote, owner, keyPair);
}

// ------------------------------------------------------------------------------------------------
export async function runTick(admin: Admin): Promise<string> {
  const bot = admin.bot("spot");
  // En pause : plus aucune entrée, mais une position ouverte reste gérée (le spot n'a pas de stop on-chain).
  const paused = bot.status === "paused";
  if (!(bot.status === "running" || (paused && (bot.position_mint || loadMemory(bot.price_history).pending)))) return "idle";
  const now = Date.now();
  const mem: Memory = loadMemory(bot.price_history);
  const patch: Partial<BotRow> = {};
  let message = "";

  // 1. Données. Sans soldes on ne fait RIEN (mais on ne s'arrête pas pour autant).
  let address: string, keyPair: Parameters<typeof executeSwap>[2], b: Balances, prices: Record<string, number>;
  try {
    ({ address, keyPair } = await loadKeyPairFrom(WALLET_ENV));
    [b, prices] = await Promise.all([getBalances(address), getPrices(ALL_MINTS).catch(() => ({} as Record<string, number>))]);
  } catch (e) {
    await save(admin, bot, mem, { last_message: `Données indisponibles (${(e as Error).message.slice(0, 80)}). Je réessaie dans une minute.` });
    return "data_unavailable";
  }
  patch.wallet_address = address;
  const totalSol = b.sol;
  let { value, complete } = portfolio(b, prices, totalSol);
  mem.brain = mem.brain ?? newBrain(value);
  const brain = mem.brain;

  // 2. Transaction en attente : on attend la vérité de la blockchain avant toute nouvelle décision.
  if (mem.pending) {
    const r = await settle(admin, bot, mem, patch, address, value);
    if (r === "pending") {
      await save(admin, bot, mem, { ...patch, last_message: "Transaction en cours de confirmation…" });
      return "pending";
    }
    message = r;
    b = await getBalances(address);
    ({ value, complete } = portfolio(b, prices, b.sol));
  }

  // 3. Réconciliation : la position, c'est ce que contient le portefeuille, pas ce que dit la base.
  let mint = patch.position_mint !== undefined ? patch.position_mint : bot.position_mint;
  if (mint && !holds(b, mint, prices)) {
    message = `Position ${symbolOf(mint)} introuvable dans le portefeuille : état remis à zéro.`;
    mint = null; Object.assign(patch, { position_mint: null, entry_price: null }); clearPosition(mem);
  }
  if (!mint) {
    const orphan = TOKENS.find((t) => t.mint !== SOL_MINT && holds(b, t.mint, prices) && prices[t.mint]);
    if (orphan) {
      const price = prices[orphan.mint]!;
      mint = orphan.mint;
      Object.assign(patch, { position_mint: mint, entry_price: price });
      Object.assign(mem, { costUsd: (b.ui[mint] ?? 0) * price, best: price, stop: price * 0.95, initialRisk: price * 0.05, openedAt: now, asset: orphan.symbol, side: "long" });
      message = `Jetons ${orphan.symbol} trouvés dans le portefeuille : je reprends leur gestion (stop de sécurité −5 %).`;
    }
  }

  // 4. Fin de mission (uniquement sur données complètes : plus jamais de faux arrêt).
  const end = missionEnd({
    now, endAt: RULES.destroyAtDeadline && bot.end_at ? Date.parse(bot.end_at) : Infinity,
    goalUsd: Number(bot.goal_usd), valueUsd: value, floorUsd: RULES.floorUsd, complete,
  });
  if (end && !paused) {
    const outcome = end === "success" ? "success" : end === "destroyed" ? "destroyed" : "stopped";
    const msg = end === "success" ? "Mission réussie ! Objectif atteint, gains sécurisés en USDC."
      : end === "destroyed" ? "Date limite atteinte : position vendue." : `Capital sous ${RULES.floorUsd} $ : je protège ce qui reste.`;
    await save(admin, bot, mem, { ...patch, last_value_usd: value });
    await liquidate(admin, { ...bot, ...patch } as BotRow, outcome, msg);
    return outcome;
  }

  try {
    // 5. Gestion de la position : stop suiveur (remonté à chaque bougie) + sortie vérifiée chaque minute.
    if (mint) {
      const token = tokenOf(mint);
      const amount = b.raw[mint] ?? 0n;
      let livePrice = prices[mint];
      try { // prix réellement obtenable en vendant TOUT maintenant (slippage compris)
        const q = await getQuote(mint, USDC_MINT, amount, RULES.exitSlippageBps);
        livePrice = Number(q.outAmount) / 1e6 / (b.ui[mint] ?? 1);
      } catch { /* on garde le prix de marché */ }
      if (!livePrice) {
        await save(admin, bot, mem, { ...patch, last_value_usd: value, last_message: `Prix ${symbolOf(mint)} momentanément indisponible, position surveillée.` });
        return "hold";
      }
      const entry = Number(patch.entry_price ?? bot.entry_price ?? livePrice);
      const closed = lastClosedCandle(now);
      if (token && mem.stopCandle !== closed) {
        const params = PRESETS[brain.preset[token.symbol] ?? "standard"];
        const candles = await hourlyCandles(token.candles, 40, now).catch(() => []);
        if (candles.length > 20) {
          mem.best = Math.max(mem.best ?? entry, candles.at(-1)!.c);
          mem.stop = trailStop("long", mem.stop ?? entry * 0.95, mem.best, atr(candles, 14).at(-1)!, params);
          mem.stopCandle = closed;
        }
      }
      const stop = mem.stop ?? entry * 0.95;
      const exit = exitCheck({ side: "long", entry, price: livePrice, stop, initialRisk: mem.initialRisk ?? entry * 0.05, openedAt: mem.openedAt ?? now }, now);
      const pnlPct = mem.costUsd ? (((b.ui[mint] ?? 0) * livePrice) / mem.costUsd - 1) * 100 : (livePrice / entry - 1) * 100;
      if (exit) {
        const sig = await sellAll(mint, b, address, keyPair);
        mem.pending = { kind: "sell", sig, at: now, mint, usdcBefore: b.usdc, reason: exit };
        const r = (await waitForTx(sig)) === "pending" ? "pending" : await settle(admin, bot, mem, patch, address, value);
        await save(admin, bot, mem, { ...patch, last_value_usd: value, last_message: r === "pending" ? `Vente ${symbolOf(mint)} envoyée (${label(exit)}), confirmation en cours…` : r });
        return "sell";
      }
      mem.live = { price: livePrice, pnlPct, at: now };
      mem.mindset = mindset(brain, { inPosition: true, blocked: null, goalPct: (value / Number(bot.goal_usd)) * 100 });
      await save(admin, bot, mem, { ...patch, last_value_usd: value,
        last_message: message || `En position ${symbolOf(mint)} : ${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)} %, stop suiveur à ${fmt(stop)} $.` });
      return "hold";
    }

    if (paused) {
      await save(admin, bot, mem, { ...patch, last_value_usd: value, last_message: message || "En pause : aucune nouvelle entrée." });
      return "paused";
    }
    // 6. Pas de position : apprentissage quotidien (un marché par tick), puis recherche d'une entrée à chaque nouvelle bougie.
    const today = dayKey(now);
    const todo = TOKENS.find((t) => brain.optimized?.[t.symbol] !== today);
    if (todo) {
      const hist = await hourlyCandles(todo.candles, 1440, now).catch(() => null);
      if (hist && hist.length > 500) optimize(brain, todo.symbol, hist, { allowShort: false, feePct: SPOT_COST, leverageCap: RISK.maxSpotFraction }, today);
      else brain.optimized = { ...brain.optimized, [todo.symbol]: today };
    }

    const blocked = riskGate(mem, value, now);
    const closed = lastClosedCandle(now);
    if (blocked || mem.lastCandle === closed) {
      mem.mindset = mindset(brain, { inPosition: false, blocked, goalPct: (value / Number(bot.goal_usd)) * 100 });
      await save(admin, bot, mem, { ...patch, last_value_usd: value, last_message: message || blocked || mem.signal || "En attente de la prochaine bougie." });
      return "hold";
    }
    mem.lastCandle = closed;

    const signals: { token: Token; sig: Signal }[] = [];
    const notes: string[] = [];
    for (const token of TOKENS) {
      if (isBenched(brain, token.symbol, now)) { notes.push(`${token.symbol} : sur le banc`); continue; }
      try {
        const candles = await hourlyCandles(token.candles, 400, now);
        const sig = trendSignal(candles, false, PRESETS[brain.preset[token.symbol] ?? "standard"]);
        if (sig.side === "long") signals.push({ token, sig }); else notes.push(`${token.symbol} : ${sig.reason}`);
      } catch { notes.push(`${token.symbol} : historique indisponible`); }
    }
    signals.sort((a, c) => c.sig.score - a.sig.score);
    const pick = signals[0];
    if (!pick) {
      mem.signal = notes.join(" · ");
      mem.mindset = mindset(brain, { inPosition: false, blocked: null, goalPct: (value / Number(bot.goal_usd)) * 100 });
      await save(admin, bot, mem, { ...patch, last_value_usd: value, last_message: message || "Aucune cassure en tendance : j'attends, patience = argent." });
      return "hold";
    }

    // 7. Entrée : taille au risque, cotation vérifiée, swap, confirmation.
    const risk = riskPerTrade(brain);
    const sizeUsd = spotSizeUsd(value, b.usdc, pick.sig.price, pick.sig.stop, risk);
    if (sizeUsd <= 0) {
      await save(admin, bot, mem, { ...patch, last_value_usd: value, last_message: `Signal ${pick.token.symbol} mais pas assez d'USDC pour un ordre (min ${RISK.minOrderUsd} $).` });
      return "hold";
    }
    const quote = await getQuote(USDC_MINT, pick.token.mint, BigInt(Math.floor(sizeUsd * 1e6)), RULES.spotSlippageBps);
    const impact = Number(quote.priceImpactPct) * 100;
    const fillPrice = sizeUsd / (Number(quote.outAmount) / 10 ** pick.token.decimals);
    if (impact > RULES.maxPriceImpactPct || fillPrice <= pick.sig.stop * 1.003) {
      await save(admin, bot, mem, { ...patch, last_value_usd: value, last_message: `Signal ${pick.token.symbol} ignoré : exécution trop chère (impact ${impact.toFixed(2)} %) ou prix déjà trop loin.` });
      return "hold";
    }
    const sig = await executeSwap(quote, address, keyPair);
    Object.assign(mem, {
      pending: { kind: "buy", sig, at: now, mint: pick.token.mint, usdcBefore: b.usdc },
      stop: pick.sig.stop, best: fillPrice, initialRisk: fillPrice - pick.sig.stop, openedAt: now, asset: pick.token.symbol, side: "long",
      signal: `${pick.token.symbol} : ${pick.sig.reason}`, stopCandle: closed,
    });
    const r = (await waitForTx(sig)) === "pending" ? "pending" : await settle(admin, bot, mem, patch, address, value);
    await save(admin, bot, mem, { ...patch, last_value_usd: value,
      last_message: r === "pending" ? `Achat ${pick.token.symbol} envoyé, confirmation en cours…` : r });
    return "buy";
  } catch (e) {
    await save(admin, bot, mem, { ...patch, last_value_usd: value, last_message: `Erreur : ${(e as Error).message}`.slice(0, 300) + " — je réessaie au prochain tick." });
    return "error";
  }
}

// ------------------------------------------------------------------------------------------------
/** Règle une transaction en attente d'après la blockchain et le portefeuille. Renvoie un message, ou "pending". */
async function settle(admin: Admin, bot: BotRow, mem: Memory, patch: Partial<BotRow>, address: string, valueBefore: number): Promise<string> {
  const p = mem.pending!;
  const st = await txStatus(p.sig).catch(() => "pending" as const);
  if (st === "pending" && Date.now() - p.at < 120_000) return "pending";
  const mint = p.mint!;
  const [b, prices] = await Promise.all([getBalances(address), getPrices([USDC_MINT, mint]).catch(() => ({} as Record<string, number>))]);
  const held = holds(b, mint, prices);
  mem.pending = undefined;

  if (p.kind === "buy") {
    if (!held) { clearPosition(mem); Object.assign(patch, { position_mint: null, entry_price: null }); return `Achat ${symbolOf(mint)} non exécuté (${st}). Aucun fonds engagé.`; }
    const cost = Math.max(0.01, (p.usdcBefore ?? 0) - b.usdc);
    const qty = b.ui[mint] ?? 0;
    const entry = qty > 0 ? cost / qty : prices[mint] ?? 0;
    mem.costUsd = cost;
    mem.best = Math.max(mem.best ?? entry, entry);
    if (!(mem.stop && mem.stop < entry)) mem.stop = entry * 0.95;
    mem.initialRisk = entry - mem.stop;
    Object.assign(patch, { position_mint: mint, entry_price: entry });
    admin.addTrade("spot", { side: "buy", symbol: symbolOf(mint), mint, amount_usd: cost, price: entry, reason: mem.signal ?? "tendance", signature: p.sig });
    return `Achat ${symbolOf(mint)} confirmé : ${cost.toFixed(2)} $ à ${fmt(entry)} $, stop à ${fmt(mem.stop)} $.`;
  }

  // vente
  if (held) return `Vente ${symbolOf(mint)} non exécutée (${st}) : je réessaie.`;
  const proceeds = Math.max(0, b.usdc - (p.usdcBefore ?? 0));
  const cost = mem.costUsd ?? proceeds;
  const pnl = proceeds - cost;
  const pnlPct = cost > 0 ? (pnl / cost) * 100 : 0;
  admin.addTrade("spot", {
    side: "sell", symbol: symbolOf(mint), mint, amount_usd: proceeds,
    price: Number(bot.entry_price ?? 0) * (1 + pnlPct / 100), pnl_usd: pnl, reason: p.reason ?? "sortie", signature: p.sig,
  });
  const brain = mem.brain ?? newBrain(valueBefore);
  learn(brain, symbolOf(mint), pnlPct, valueBefore + pnl, Date.now());
  if (pnl < 0) mem.cooldownUntil = Date.now() + RISK.cooldownAfterLossMs;
  clearPosition(mem);
  Object.assign(patch, { position_mint: null, entry_price: null });
  return `Vente ${symbolOf(mint)} confirmée (${label(p.reason)}) : ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)} $ (${pnlPct.toFixed(1)} %), frais inclus.`;
}

/** Vend tout et termine la mission (signature inchangée pour l'interface existante). */
export async function liquidate(admin: Admin, bot: BotRow, outcome: "success" | "destroyed" | "stopped", message: string) {
  const { address, keyPair } = await loadKeyPairFrom(WALLET_ENV);
  const mem = loadMemory(bot.price_history);
  let b = await getBalances(address);
  const prices = await getPrices(ALL_MINTS).catch(() => ({} as Record<string, number>));
  const failures: string[] = [];
  for (const t of TOKENS) {
    if (t.mint === SOL_MINT || !holds(b, t.mint, prices)) continue;
    try {
      const usdcBefore = b.usdc;
      const sig = await sellAll(t.mint, b, address, keyPair);
      const st = await waitForTx(sig, 25_000);
      if (st !== "confirmed") throw new Error(`transaction ${st}`);
      b = await getBalances(address);
      const proceeds = b.usdc - usdcBefore;
      const cost = t.mint === bot.position_mint ? mem.costUsd ?? proceeds : proceeds;
      admin.addTrade("spot", { side: "sell", symbol: t.symbol, mint: t.mint, amount_usd: proceeds, price: prices[t.mint] ?? 0, pnl_usd: proceeds - cost, reason: outcome, signature: sig });
    } catch (e) {
      failures.push(`${t.symbol} : ${(e as Error).message}`);
    }
  }
  clearPosition(mem);
  const finalValue = portfolio(b, prices, b.sol).value;
  admin.update("spot", {
    status: failures.length ? "running" : outcome, // si la vente échoue, le bot continue de gérer la position au lieu de l'abandonner
    position_mint: failures.length ? bot.position_mint : null, entry_price: failures.length ? bot.entry_price : null,
    price_history: mem as never, last_value_usd: finalValue, last_tick_at: new Date().toISOString(),
    last_message: (failures.length ? `${message} Vente impossible (${failures.join(", ")}) : je garde la main et je réessaie.` : message).slice(0, 300),
  });
}

// ------------------------------------------------------------------------------------------------
function clearPosition(mem: Memory) {
  for (const k of ["stop", "best", "initialRisk", "openedAt", "costUsd", "asset", "side", "stopCandle", "live"] as const) delete mem[k];
}
async function save(admin: Admin, bot: BotRow, mem: Memory, fields: Partial<BotRow>) {
  void bot;
  admin.update("spot", { price_history: mem, last_tick_at: new Date().toISOString(), ...fields });
}
const fmt = (n: number) => (n >= 1 ? n.toFixed(n >= 100 ? 2 : 4) : n.toPrecision(4));
function label(reason?: string) {
  return reason === "trailing_stop" ? "stop suiveur, gain protégé" : reason === "stop_loss" ? "stop loss" : reason === "time_stop" ? "position sans élan" : reason ?? "sortie";
}
