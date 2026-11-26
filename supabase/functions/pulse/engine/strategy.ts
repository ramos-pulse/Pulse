// Règles de trading pures (aucun réseau, aucun secret) : testables et backtestables.
//
// STRATÉGIE « SUIVI DE TENDANCE » (remplace le scalping 1 minute, structurellement perdant après frais)
// ---------------------------------------------------------------------------------------------------
// - Bougies 1 heure (le bruit de la minute disparaît, les frais deviennent négligeables).
// - On ne trade QUE dans le sens de la tendance de fond : EMA 50 au-dessus de l'EMA 200 (long) ou en dessous (short perps).
// - Tendance assez FORTE (écart des moyennes ≥ 1-1,5 ATR, moyenne lente qui monte) : évite les fausses cassures en range.
// - Entrée sur cassure : clôture au-dessus du plus haut des 24-72 dernières heures (ou sous le plus bas pour un short).
// - Volatilité filtrée : ATR entre 0,4 % et 5 % du prix (ni marché mort, ni chaos).
// - Stop initial à 2 ATR, puis stop suiveur « chandelier » (meilleure clôture − 2,5 à 3,5 ATR) : on coupe vite les pertes
//   et on laisse courir les gains. Pas de take profit fixe : ce sont les grosses tendances qui paient la stratégie.
// - Taille de position calculée pour ne risquer que RISK_PER_TRADE du capital si le stop est touché.
// - Limite de perte journalière + pause après une perte.
// Résultat attendu d'un suivi de tendance : 35-45 % de trades gagnants, mais des gains moyens 2 à 3 fois plus gros
// que les pertes. Peu de trades (quelques-uns par semaine). VALIDER AVEC LE BACKTEST AVANT DE METTRE DE L'ARGENT.

export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const SOL_MINT = "So11111111111111111111111111111111111111112";

/**
 * Univers de tokens « établis » que les bots et le chercheur peuvent trader (jamais de memecoin de quelques heures).
 * `candles` = produit Coinbase pour l'historique. `verify` = l'adresse est contrôlée sur Jupiter (symbole + décimales)
 * avant tout achat : si le contrôle échoue, le token est simplement ignoré.
 */
export const TOKENS = [
  { symbol: "SOL", mint: SOL_MINT, decimals: 9, candles: "SOL-USD", verify: false },
  { symbol: "JUP", mint: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN", decimals: 6, candles: "JUP-USD", verify: false },
  { symbol: "BONK", mint: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263", decimals: 5, candles: "BONK-USD", verify: false },
  { symbol: "WBTC", mint: "3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh", decimals: 8, candles: "BTC-USD", verify: false },
  { symbol: "WETH", mint: "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs", decimals: 8, candles: "ETH-USD", verify: false },
  { symbol: "WIF", mint: "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm", decimals: 6, candles: "WIF-USD", verify: true },
  { symbol: "JTO", mint: "jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL", decimals: 9, candles: "JTO-USD", verify: true },
  { symbol: "PYTH", mint: "HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3", decimals: 6, candles: "PYTH-USD", verify: true },
  { symbol: "RENDER", mint: "rndrizKT3MK1iimdxRdWabcF7Zg7AR5T4nud4EkHBof", decimals: 8, candles: "RENDER-USD", verify: true },
  { symbol: "RAY", mint: "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R", decimals: 6, candles: "RAY-USD", verify: true },
  { symbol: "POPCAT", mint: "7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr", decimals: 9, candles: "POPCAT-USD", verify: true },
] as const;

/** Unités de temps des bougies : 1 h (suivi de tendance classique) ou 15 min (scalping prudent). */
export type Interval = "1h" | "15m";
export const INTERVAL_MS: Record<Interval, number> = { "1h": 3_600_000, "15m": 900_000 };
export const asInterval = (v: unknown): Interval => (v === "15m" ? "15m" : "1h");

/** Un « plan » choisi par le chercheur : quel token, quelle stratégie, quels réglages, quelle unité de temps. */
export type Confidence = "nouvelle" | "confirmée";
export interface SpotPlan { symbol: string; family: "tendance" | "rsi"; params: Params | RsiParams; interval: Interval; source: string; score: number; confidence: Confidence }
export interface PerpsPlan { asset: string; params: Params; interval: Interval; source: string; score: number; confidence: Confidence }
/** Les bots apprennent du chercheur : une stratégie pas encore confirmée en réel est tradée avec 75 % du risque normal. */
export const PROBATION_RISK = 0.75;
export const riskFactor = (c: Confidence | undefined) => (c === "confirmée" ? 1 : PROBATION_RISK);
const asConfidence = (v: unknown): Confidence => (v === "confirmée" ? "confirmée" : "nouvelle");

export interface Params { breakout: number; trailAtr: number; minTrend: number }
/** Jeux de paramètres testés chaque jour par le cerveau du bot (peu nombreux pour éviter la sur-optimisation). */
export const PRESETS: Record<string, Params> = {
  rapide: { breakout: 24, trailAtr: 2.5, minTrend: 1.0 },
  standard: { breakout: 48, trailAtr: 3.0, minTrend: 1.2 },
  lent: { breakout: 72, trailAtr: 3.5, minTrend: 1.5 },
};
export const DEFAULT_PARAMS = PRESETS.standard!;

export const STRATEGY = {
  slopeBars: 24,         // l'EMA lente doit monter (long) / descendre (short) sur 24 h
  emaFast: 50,
  emaSlow: 200,
  atrPeriod: 14,
  minAtrPct: 0.004,
  maxAtrPct: 0.05,
  stopAtr: 2.0,          // stop initial
  momentumBars: 168,     // classement des jetons spot : performance sur 7 jours
  maxHoldHours: 96,      // sortie si la position stagne trop longtemps…
  minProgressR: 0.5,     // …sans avoir gagné au moins 0,5 × le risque initial
};

export const RISK = {
  perTrade: 0.015,       // 1,5 % du capital perdu si le stop est touché
  dailyLoss: 0.05,       // −5 % sur la journée (UTC) : plus d'entrée jusqu'au lendemain
  cooldownAfterLossMs: 60 * 60_000,
  maxSpotFraction: 0.95, // part max du portefeuille dans une position spot
  minOrderUsd: 2,
};

export const RULES = {
  floorUsd: 5,
  destroyAtDeadline: false, // la date limite est un objectif, pas une autodestruction : le bot n'abandonne pas
  durationDays: 30,
  spotSlippageBps: 50,
  exitSlippageBps: 150,  // une sortie doit passer, quitte à glisser un peu plus
  maxPriceImpactPct: 0.4,
  // Champs conservés pour l'interface existante (valeurs indicatives, les vrais niveaux sont dynamiques).
  takeProfit: 0, stopLoss: -STRATEGY.stopAtr, historyMax: 0, window: 0, entryMomentum: 0, trailActivate: 0, trailGap: 0,
};

export const PERPS_RULES = {
  maxLeverage: 3,        // le levier réel découle du risque ; x3 maximum (liquidation à ~−30 %, très loin du stop)
  minCollateralUsd: 10,
  floorUsd: 5,
  slippageBps: 100,
  // Champs conservés pour l'interface existante.
  takeProfit: 0, stopLoss: -STRATEGY.stopAtr, entryMomentum: 0, window: 0, trailActivate: 0, trailGap: 0,
};

/** Marchés Jupiter Perps : SOL, ETH et BTC. */
export const PERPS_ASSETS = [
  { asset: "SOL", mint: SOL_MINT, candles: "SOL-USD" },
  { asset: "ETH", mint: "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs", candles: "ETH-USD" },
  { asset: "BTC", mint: "3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh", candles: "BTC-USD" },
] as const;
export type PerpsAsset = (typeof PERPS_ASSETS)[number]["asset"];
export type PerpsSide = "long" | "short";
export type Side = PerpsSide;

// ---------------------------------------------------------------------------------------------------
// Bougies & indicateurs
// ---------------------------------------------------------------------------------------------------
export interface Candle { t: number; o: number; h: number; l: number; c: number } // t = ouverture, en ms

export function ema(values: number[], period: number): number[] {
  if (!values.length) return [];
  const k = 2 / (period + 1);
  const out = [values[0]!];
  for (let i = 1; i < values.length; i++) out.push(values[i]! * k + out[i - 1]! * (1 - k));
  return out;
}

export function atr(c: Candle[], period: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < c.length; i++) {
    const cur = c[i]!;
    const tr = i === 0 ? cur.h - cur.l : Math.max(cur.h - cur.l, Math.abs(cur.h - c[i - 1]!.c), Math.abs(cur.l - c[i - 1]!.c));
    out.push(i < period ? (i === 0 ? tr : (out[i - 1]! * i + tr) / (i + 1)) : (out[i - 1]! * (period - 1) + tr) / period);
  }
  return out;
}

export interface Signal { side: Side | null; reason: string; price: number; atr: number; stop: number; candleTime: number; score: number }

/** Analyse les bougies CLÔTURÉES. Renvoie un signal d'entrée long/short (ou aucun) sur la dernière bougie. */
export function trendSignal(candles: Candle[], allowShort: boolean, P: Params = DEFAULT_PARAMS): Signal {
  const S = STRATEGY;
  const last = candles[candles.length - 1];
  const empty = (reason: string): Signal => ({ side: null, reason, price: last?.c ?? 0, atr: 0, stop: 0, candleTime: last?.t ?? 0, score: 0 });
  if (!last || candles.length < S.emaSlow + 5) return empty(`historique insuffisant (${candles.length} bougies)`);

  const closes = candles.map((x) => x.c);
  const fast = ema(closes, S.emaFast).at(-1)!;
  const slowLine = ema(closes, S.emaSlow);
  const slow = slowLine.at(-1)!;
  const slowBefore = slowLine.at(-1 - S.slopeBars)!;
  const a = atr(candles, S.atrPeriod).at(-1)!;
  const atrPct = a / last.c;
  if (atrPct < S.minAtrPct) return empty(`marché trop calme (ATR ${(atrPct * 100).toFixed(2)} %)`);
  if (atrPct > S.maxAtrPct) return empty(`marché trop agité (ATR ${(atrPct * 100).toFixed(2)} %)`);

  const strength = Math.abs(fast - slow) / a; // écart des moyennes en nombre d'ATR = force de la tendance
  const window = candles.slice(-P.breakout - 1, -1);
  const hi = Math.max(...window.map((x) => x.h));
  const lo = Math.min(...window.map((x) => x.l));
  const ref = closes[Math.max(0, closes.length - 1 - S.momentumBars)]!;
  const momentum = last.c / ref - 1;

  if (strength < P.minTrend) return empty(`tendance trop faible (${strength.toFixed(1)} ATR < ${P.minTrend})`);
  if (fast > slow && slow > slowBefore && last.c > slow && last.c > hi) {
    return { side: "long", reason: `cassure du plus haut ${P.breakout} h en tendance haussière (force ${strength.toFixed(1)})`, price: last.c, atr: a,
      stop: last.c - S.stopAtr * a, candleTime: last.t, score: momentum };
  }
  if (allowShort && fast < slow && slow < slowBefore && last.c < slow && last.c < lo) {
    return { side: "short", reason: `cassure du plus bas ${P.breakout} h en tendance baissière (force ${strength.toFixed(1)})`, price: last.c, atr: a,
      stop: last.c + S.stopAtr * a, candleTime: last.t, score: -momentum };
  }
  const trend = fast > slow ? "haussière" : "baissière";
  return empty(`tendance ${trend}, pas de cassure (zone ${fmt(lo)} – ${fmt(hi)})`);
}

const fmt = (n: number) => (n >= 1 ? n.toFixed(2) : n.toPrecision(3));

/** Stop suiveur : ne recule jamais. `best` = meilleure clôture depuis l'entrée (la plus haute en long, la plus basse en short). */
export function trailStop(side: Side, current: number, best: number, atrNow: number, P: Params = DEFAULT_PARAMS): number {
  const chandelier = side === "long" ? best - P.trailAtr * atrNow : best + P.trailAtr * atrNow;
  return side === "long" ? Math.max(current, chandelier) : Math.min(current, chandelier);
}

export type ExitReason = "stop_loss" | "trailing_stop" | "time_stop";

/** Sortie vérifiée à chaque tick (prix en direct) contre le stop calculé sur les bougies. */
export function exitCheck(p: { side: Side; entry: number; price: number; stop: number; initialRisk: number; openedAt: number }, now: number): ExitReason | null {
  const hit = p.side === "long" ? p.price <= p.stop : p.price >= p.stop;
  if (hit) {
    const locked = p.side === "long" ? p.stop >= p.entry : p.stop <= p.entry;
    return locked ? "trailing_stop" : "stop_loss";
  }
  const hours = (now - p.openedAt) / 3_600_000;
  const r = p.initialRisk > 0 ? ((p.side === "long" ? p.price - p.entry : p.entry - p.price) / p.initialRisk) : 0;
  if (hours >= STRATEGY.maxHoldHours && r < STRATEGY.minProgressR) return "time_stop";
  return null;
}

// ---------------------------------------------------------------------------------------------------
// Taille des positions
// ---------------------------------------------------------------------------------------------------
/** Spot : montant USDC à investir pour risquer RISK.perTrade du capital jusqu'au stop. */
export function spotSizeUsd(equity: number, usdc: number, entry: number, stop: number, risk = RISK.perTrade): number {
  const dist = (entry - stop) / entry;
  if (!(dist > 0)) return 0;
  const size = Math.min((equity * risk) / dist, equity * RISK.maxSpotFraction, usdc);
  return size >= RISK.minOrderUsd ? size : 0;
}

/** Perps : collatéral et levier pour risquer `risk` du capital, levier plafonné à `maxLev`. */
export function perpsSizing(equity: number, usdc: number, entry: number, stop: number, risk = RISK.perTrade, maxLev: number = PERPS_RULES.maxLeverage) {
  const dist = Math.abs(entry - stop) / entry;
  if (!(dist > 0)) return null;
  const notional = (equity * risk) / dist;
  let collateral = Math.max(PERPS_RULES.minCollateralUsd, notional / maxLev);
  if (collateral > usdc) return null;
  let leverage = notional / collateral;
  if (leverage < 1.1) { leverage = 1.1; collateral = notional / leverage; }
  if (collateral < PERPS_RULES.minCollateralUsd) return null; // capital trop faible pour respecter le risque
  return { collateral, leverage: Math.min(leverage, maxLev), notional };
}

// ---------------------------------------------------------------------------------------------------
// Réglages du bot perps : mode agressif et biais longs / shorts
// ---------------------------------------------------------------------------------------------------
export type PerpsMode = "normal" | "agressif";
export interface PerpsConfig { mode: PerpsMode; bias: number; trend: Params | null; source?: string; autopilot: boolean; plan: PerpsPlan | null } // bias : -100 = shorts seulement, 0 = équilibré, +100 = longs seulement

/** Mode agressif : risque doublé (plafond 3 %), levier jusqu'à x5, perte max 8 %/jour, trade même sans réglage validé. */
export const AGGRESSIVE = { riskMult: 2, maxRisk: 0.03, maxLeverage: 5, dailyLoss: 0.08 };

export function loadPerpsConfig(raw: unknown): PerpsConfig {
  const o = (raw && typeof raw === "object" ? raw : {}) as Partial<PerpsConfig>;
  const bias = Number(o.bias);
  return { mode: o.mode === "agressif" ? "agressif" : "normal", bias: Number.isFinite(bias) ? Math.round(Math.min(100, Math.max(-100, bias))) : 0,
    trend: sanitizeTrend(o.trend), ...(typeof o.source === "string" ? { source: o.source.slice(0, 120) } : {}),
    autopilot: o.autopilot === true, plan: sanitizePerpsPlan(o.plan) };
}

export function sanitizePerpsPlan(raw: unknown): PerpsPlan | null {
  if (!raw || typeof raw !== "object") return null;
  const x = raw as Partial<PerpsPlan>;
  if (!PERPS_ASSETS.some((a) => a.asset === x.asset)) return null;
  const params = sanitizeTrend(x.params);
  if (!params) return null;
  return { asset: String(x.asset), params, interval: asInterval(x.interval), source: String(x.source ?? "").slice(0, 120), score: Number(x.score) || 0, confidence: asConfidence(x.confidence) };
}

/** Part de la taille normale accordée à un côté (1 = 100 %, 0 = côté désactivé). Le côté favorisé garde 100 %. */
export function sideMult(bias: number, side: Side): number {
  return side === "long" ? (bias >= 0 ? 1 : 1 + bias / 100) : (bias <= 0 ? 1 : 1 - bias / 100);
}

export function perpsChange(side: Side, entry: number, current: number): number {
  return side === "long" ? (current - entry) / entry : (entry - current) / entry;
}

// ---------------------------------------------------------------------------------------------------
// Mémoire du bot (stockée dans la colonne JSON `price_history`, aucune migration de base nécessaire)
// ---------------------------------------------------------------------------------------------------
export interface Pending { kind: "buy" | "sell" | "open" | "close"; sig: string; at: number; mint?: string; usdcBefore?: number; reason?: string }
export interface Memory {
  v: 3;
  stop?: number;            // niveau de stop actuel
  best?: number;            // meilleure clôture depuis l'entrée
  initialRisk?: number;     // distance entrée → stop initial (en prix)
  stopCandle?: number;      // dernière bougie ayant servi à remonter le stop
  side?: Side;
  strategy?: SpotStrategy;  // stratégie qui a ouvert la position (gérée jusqu'au bout avec ses propres règles)
  posParams?: Params | RsiParams; // réglages exacts de la position en cours (venant d'un plan du chercheur)
  posInterval?: Interval;   // unité de temps de la position en cours
  seen?: Record<string, number>; // dernière bougie analysée par plan (« SOL|15m » → horodatage)
  source?: string;          // stratégie qui a ouvert la position (« chercheur #123 · Spot WIF » ou « réglages de l'app »)
  openedAt?: number;
  costUsd?: number;         // spot : USDC réellement dépensés (frais compris)
  openValueUsd?: number;    // perps : valeur du portefeuille juste avant l'ouverture
  lastCandle?: number;      // dernière bougie déjà analysée pour une entrée
  pending?: Pending;
  cooldownUntil?: number;
  day?: string;
  dayStartValue?: number;
  signal?: string;          // dernière analyse lisible (affichée dans l'app)
  mindset?: string;         // ce que le bot « pense » (affiché dans l'app)
  asset?: string;           // marché de la position en cours
  live?: { price: number; pnlPct: number; at: number }; // dernier prix vu de la position (affiché dans l'app)
  brain?: import("./brain.ts").Brain;
}

export function loadMemory(raw: unknown): Memory {
  if (raw && typeof raw === "object" && (raw as { v?: number }).v === 3) return raw as Memory;
  return { v: 3 }; // ancien format (historique de prix minute) : repart de zéro
}

export const dayKey = (now: number) => new Date(now).toISOString().slice(0, 10);

/** Met à jour le capital de début de journée et dit si les entrées sont bloquées. */
export function riskGate(mem: Memory, valueUsd: number, now: number, dailyLoss: number = RISK.dailyLoss): string | null {
  const today = dayKey(now);
  if (mem.day !== today || !mem.dayStartValue) { mem.day = today; mem.dayStartValue = valueUsd; }
  if (valueUsd <= mem.dayStartValue * (1 - dailyLoss)) return `perte du jour > ${Math.round(dailyLoss * 100)} % : plus d'entrée aujourd'hui`;
  if (mem.cooldownUntil && now < mem.cooldownUntil) return `pause après une perte (encore ${Math.ceil((mem.cooldownUntil - now) / 60_000)} min)`;
  return null;
}

export function endDate(start: Date): Date {
  return new Date(start.getTime() + RULES.durationDays * 24 * 60 * 60 * 1000);
}

export type MissionEnd = "success" | "destroyed" | "floor";
/** Fin de mission : seulement sur des données COMPLÈTES (évite les faux arrêts du type « solde 0 $ »). */
export function missionEnd(p: { now: number; endAt: number; goalUsd: number; valueUsd: number; floorUsd: number; complete: boolean }): MissionEnd | null {
  if (!p.complete) return null;
  if (p.valueUsd >= p.goalUsd) return "success";
  if (p.now >= p.endAt) return "destroyed";
  if (p.valueUsd < p.floorUsd) return "floor";
  return null;
}

// ---------------------------------------------------------------------------------------------------
// Backtest : rejoue la stratégie sur l'historique, frais inclus.
// ---------------------------------------------------------------------------------------------------
export interface BacktestResult {
  trades: number; winRate: number; profitFactor: number; returnPct: number; maxDrawdownPct: number;
  avgWinPct: number; avgLossPct: number; days: number; log: { side: Side; entry: number; exit: number; pnlPct: number; reason: string; t: number }[];
}

/** feePct = coût par côté (frais + slippage), en fraction. hourlyCost = coût de portage par heure (perps). */
export function backtest(candles: Candle[], o: { allowShort: boolean; feePct: number; hourlyCost?: number; leverageCap?: number; params?: Params; risk?: number; bias?: number }): BacktestResult {
  const P = o.params ?? DEFAULT_PARAMS;
  let equity = 1, peak = 1, maxDd = 0;
  const log: BacktestResult["log"] = [];
  let pos: { side: Side; entry: number; stop: number; best: number; risk: number; openedAt: number; size: number } | null = null;
  let cooldownUntil = 0;
  const atrs = atr(candles, STRATEGY.atrPeriod);

  for (let i = STRATEGY.emaSlow + 5; i < candles.length; i++) {
    const c = candles[i]!;
    if (pos) {
      // stop touché pendant la bougie (on suppose le pire : exécution au stop, ou à l'ouverture si gap)
      const hit = pos.side === "long" ? c.l <= pos.stop : c.h >= pos.stop;
      let exit: number | null = null, reason = "";
      if (hit) {
        exit = pos.side === "long" ? Math.min(c.o, pos.stop) : Math.max(c.o, pos.stop);
        reason = (pos.side === "long" ? pos.stop >= pos.entry : pos.stop <= pos.entry) ? "trailing_stop" : "stop_loss";
      } else {
        const r = pos.risk > 0 ? (pos.side === "long" ? c.c - pos.entry : pos.entry - c.c) / pos.risk : 0;
        if ((c.t - pos.openedAt) / 3_600_000 >= STRATEGY.maxHoldHours && r < STRATEGY.minProgressR) { exit = c.c; reason = "time_stop"; }
      }
      if (exit !== null) {
        const move = perpsChange(pos.side, pos.entry, exit);
        const hours = (c.t - pos.openedAt) / 3_600_000;
        const pnl = pos.size * (move - 2 * o.feePct - (o.hourlyCost ?? 0) * hours);
        equity *= 1 + pnl;
        log.push({ side: pos.side, entry: pos.entry, exit, pnlPct: pnl * 100, reason, t: c.t });
        if (pnl < 0) cooldownUntil = c.t + RISK.cooldownAfterLossMs;
        pos = null;
      } else {
        pos.best = pos.side === "long" ? Math.max(pos.best, c.c) : Math.min(pos.best, c.c);
        pos.stop = trailStop(pos.side, pos.stop, pos.best, atrs[i]!, P);
      }
    }
    if (!pos && c.t >= cooldownUntil) {
      const sig = trendSignal(candles.slice(Math.max(0, i - 400), i + 1), o.allowShort, P);
      const mult = sig.side ? sideMult(o.bias ?? 0, sig.side) : 0;
      if (sig.side && mult > 0) {
        const dist = Math.abs(sig.price - sig.stop) / sig.price;
        const size = Math.min(((o.risk ?? RISK.perTrade) * mult) / dist, o.leverageCap ?? RISK.maxSpotFraction); // fraction du capital exposée
        pos = { side: sig.side, entry: sig.price, stop: sig.stop, best: sig.price, risk: Math.abs(sig.price - sig.stop), openedAt: c.t, size };
      }
    }
    peak = Math.max(peak, equity);
    maxDd = Math.max(maxDd, 1 - equity / peak);
  }
  const wins = log.filter((x) => x.pnlPct > 0), losses = log.filter((x) => x.pnlPct <= 0);
  const gw = wins.reduce((s, x) => s + x.pnlPct, 0), gl = -losses.reduce((s, x) => s + x.pnlPct, 0);
  const first = candles[STRATEGY.emaSlow + 5], lastC = candles.at(-1);
  return {
    trades: log.length,
    winRate: log.length ? (wins.length / log.length) * 100 : 0,
    profitFactor: gl > 0 ? gw / gl : gw > 0 ? Infinity : 0,
    returnPct: (equity - 1) * 100,
    maxDrawdownPct: maxDd * 100,
    avgWinPct: wins.length ? gw / wins.length : 0,
    avgLossPct: losses.length ? -gl / losses.length : 0,
    days: first && lastC ? (lastC.t - first.t) / 86_400_000 : 0,
    log,
  };
}

// ---------------------------------------------------------------------------------------------------
// Compatibilité avec l'ancien code (à supprimer quand plus rien ne les importe)
// ---------------------------------------------------------------------------------------------------
/** @deprecated le correctif ponctuel du 25/11 est supprimé : la cause (transactions non confirmées) est corrigée. */
export const canRepairFalseStop = (..._args: unknown[]) => false;
export type History = Record<string, number[]>;
export const PEAK_KEY = "peak";
export function perpsLeverage(requested: number): number {
  return Math.min(PERPS_RULES.maxLeverage, Math.max(1.1, requested));
}

// ---------------------------------------------------------------------------------------------------
// STRATÉGIE RSI « excès de baisse dans une tendance haussière » (au choix pour le bot spot, achat uniquement)
//  - Achat quand le RSI vient de passer sous le seuil d'entrée, si la clôture est au-dessus de sa moyenne mobile.
//  - Sortie à la clôture d'une bougie quand le RSI repasse au-dessus du seuil de sortie.
//  - Stop sous le dernier creux (plus bas des N dernières bougies), jamais déplacé.
//  - Risque fixe en % du compte, taille calculée depuis la distance du stop.
//  - Mode naïf (comparaison) : RSI sous le seuil = achat, RSI au-dessus de 70 = vente, sans filtre de tendance.
//  Décisions prises à la clôture des bougies 1 h. Une position à la fois. Pas de grille, pas de martingale.
// ---------------------------------------------------------------------------------------------------
export interface RsiParams { rsiPeriod: number; entry: number; exit: number; smaPeriod: number; swingBars: number; riskPct: number; naive: boolean }
export const RSI_DEFAULTS: RsiParams = { rsiPeriod: 14, entry: 30, exit: 50, smaPeriod: 200, swingBars: 10, riskPct: 1, naive: false };
export const NAIVE_EXIT = 70;

export type SpotStrategy = "tendance" | "rsi";
export interface SpotConfig { strategy: SpotStrategy; rsi: RsiParams; trend: Params | null; source?: string; autopilot: boolean; plans: SpotPlan[]; swapAuto: boolean }

/** Réglages de tendance personnalisés (appliqués depuis le chercheur) ; null = le cerveau choisit chaque jour. */
export function sanitizeTrend(t: unknown): Params | null {
  if (!t || typeof t !== "object") return null;
  const x = t as Partial<Params>;
  const b = Number(x.breakout), a = Number(x.trailAtr), m = Number(x.minTrend);
  if (![b, a, m].every(Number.isFinite)) return null;
  return { breakout: Math.round(Math.min(168, Math.max(6, b))), trailAtr: Math.min(6, Math.max(1, a)), minTrend: Math.min(4, Math.max(0, m)) };
}

const clamp = (v: unknown, lo: number, hi: number, def: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def;
};

/** Valide et borne les réglages envoyés par l'app (jamais de valeur absurde). */
export function sanitizeRsi(p: Partial<RsiParams> | null | undefined): RsiParams {
  const d = RSI_DEFAULTS, x = p ?? {};
  const entry = Math.round(clamp(x.entry, 5, 50, d.entry));
  return {
    rsiPeriod: Math.round(clamp(x.rsiPeriod, 2, 50, d.rsiPeriod)),
    entry,
    exit: Math.round(clamp(x.exit, entry + 1, 95, Math.max(d.exit, entry + 1))),
    smaPeriod: Math.round(clamp(x.smaPeriod, 10, 300, d.smaPeriod)),
    swingBars: Math.round(clamp(x.swingBars, 2, 50, d.swingBars)),
    riskPct: Math.round(clamp(x.riskPct, 0.1, 3, d.riskPct) * 10) / 10,
    naive: x.naive === true,
  };
}

export function loadConfig(raw: unknown): SpotConfig {
  const o = (raw && typeof raw === "object" ? raw : {}) as Partial<SpotConfig>;
  return { strategy: o.strategy === "rsi" ? "rsi" : "tendance", rsi: sanitizeRsi(o.rsi), trend: sanitizeTrend(o.trend), ...(typeof o.source === "string" ? { source: o.source.slice(0, 120) } : {}),
    autopilot: o.autopilot === true, plans: sanitizeSpotPlans(o.plans), swapAuto: o.swapAuto !== false };
}

const SYMBOLS = new Set<string>(TOKENS.map((t) => t.symbol));
export function sanitizeSpotPlans(raw: unknown): SpotPlan[] {
  if (!Array.isArray(raw)) return [];
  const out: SpotPlan[] = [];
  for (const x of raw as Partial<SpotPlan>[]) {
    if (out.length >= 3) break; // 3 plans maximum, comptés après avoir écarté les tokens inconnus
    if (!x || !SYMBOLS.has(String(x.symbol))) continue;
    const family = x.family === "rsi" ? "rsi" : "tendance";
    const params = family === "rsi" ? sanitizeRsi(x.params as Partial<RsiParams>) : sanitizeTrend(x.params);
    if (!params) continue;
    out.push({ symbol: String(x.symbol), family, params, interval: asInterval(x.interval), source: String(x.source ?? "").slice(0, 120), score: Number(x.score) || 0, confidence: asConfidence(x.confidence) });
  }
  return out;
}

/** RSI de Wilder ; NaN tant qu'il n'y a pas assez de bougies. */
export function rsiSeries(closes: number[], n: number): number[] {
  const out: number[] = new Array(closes.length).fill(NaN);
  let gain = 0, loss = 0;
  for (let i = 1; i < closes.length; i++) {
    const ch = closes[i]! - closes[i - 1]!;
    const g = Math.max(ch, 0), l = Math.max(-ch, 0);
    if (i <= n) {
      gain += g / n; loss += l / n;
      if (i === n) out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
      continue;
    }
    gain = (gain * (n - 1) + g) / n;
    loss = (loss * (n - 1) + l) / n;
    out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  }
  return out;
}

/** Moyenne mobile simple ; NaN tant qu'il n'y a pas assez de bougies. */
export function smaSeries(values: number[], n: number): number[] {
  const out: number[] = new Array(values.length).fill(NaN);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i]!;
    if (i >= n) sum -= values[i - n]!;
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
}

/** Signal d'entrée sur la bougie d'indice i (séries précalculées). */
function rsiEntryAt(c: Candle[], r: number[], s: number[], i: number, p: RsiParams): { stop: number; reason: string } | null {
  const now = r[i]!, prev = r[i - 1]!, close = c[i]!.c;
  if (!Number.isFinite(now) || !Number.isFinite(prev)) return null;
  let ok: boolean;
  if (p.naive) ok = now < p.entry;
  else ok = prev >= p.entry && now < p.entry && Number.isFinite(s[i]!) && close > s[i]!;
  if (!ok) return null;
  let stop = Infinity;
  for (let k = Math.max(0, i - p.swingBars + 1); k <= i; k++) stop = Math.min(stop, c[k]!.l);
  if (!(stop < close)) return null;
  const reason = p.naive
    ? `RSI ${now.toFixed(0)} sous ${p.entry} (mode naïf, sans filtre de tendance)`
    : `RSI ${now.toFixed(0)} vient de passer sous ${p.entry}, prix au-dessus de la MM${p.smaPeriod}`;
  return { stop, reason };
}

/** Analyse la dernière bougie clôturée pour la stratégie RSI. */
export function rsiSignal(candles: Candle[], p: RsiParams): Signal {
  const last = candles.at(-1);
  const empty = (reason: string): Signal => ({ side: null, reason, price: last?.c ?? 0, atr: 0, stop: 0, candleTime: last?.t ?? 0, score: 0 });
  const need = (p.naive ? p.rsiPeriod : Math.max(p.smaPeriod, p.rsiPeriod)) + 2;
  if (!last || candles.length < need) return empty(`historique insuffisant (${candles.length}/${need} bougies)`);
  const closes = candles.map((x) => x.c);
  const r = rsiSeries(closes, p.rsiPeriod), s = smaSeries(closes, p.smaPeriod);
  const i = candles.length - 1;
  const hit = rsiEntryAt(candles, r, s, i, p);
  if (hit) return { side: "long", reason: hit.reason, price: last.c, atr: 0, stop: hit.stop, candleTime: last.t, score: p.entry - r[i]! };
  const trend = Number.isFinite(s[i]!) ? (last.c > s[i]! ? `au-dessus de la MM${p.smaPeriod}` : `sous la MM${p.smaPeriod} (pas d'achat)`) : "";
  return empty(`RSI ${Number.isFinite(r[i]!) ? r[i]!.toFixed(0) : "—"}, prix ${trend}`.trim());
}

/** Sortie à la clôture : RSI repassé au-dessus du seuil de sortie (70 en mode naïf). */
export function rsiExitSignal(candles: Candle[], p: RsiParams): { exit: boolean; rsi: number } {
  const r = rsiSeries(candles.map((x) => x.c), p.rsiPeriod);
  const now = r.at(-1)!;
  return { exit: Number.isFinite(now) && now > (p.naive ? NAIVE_EXIT : p.exit), rsi: now };
}

/** Backtest de la stratégie RSI, frais inclus (feePct par côté). */
export function backtestRsi(candles: Candle[], p: RsiParams, feePct: number): BacktestResult {
  const closes = candles.map((x) => x.c);
  const r = rsiSeries(closes, p.rsiPeriod), s = smaSeries(closes, p.smaPeriod);
  const exitLevel = p.naive ? NAIVE_EXIT : p.exit;
  let equity = 1, peak = 1, maxDd = 0;
  const log: BacktestResult["log"] = [];
  let pos: { entry: number; stop: number; size: number } | null = null;
  const start = Math.max(p.smaPeriod, p.rsiPeriod) + 2;
  for (let i = start; i < candles.length; i++) {
    const c = candles[i]!;
    if (pos) {
      let exit: number | null = null, reason = "";
      if (c.l <= pos.stop) { exit = Math.min(c.o, pos.stop); reason = "stop_loss"; }
      else if (r[i]! > exitLevel) { exit = c.c; reason = "rsi_exit"; }
      if (exit !== null) {
        const pnl = pos.size * ((exit - pos.entry) / pos.entry - 2 * feePct);
        equity *= 1 + pnl;
        log.push({ side: "long", entry: pos.entry, exit, pnlPct: pnl * 100, reason, t: c.t });
        pos = null;
      }
    } else {
      const hit = rsiEntryAt(candles, r, s, i, p);
      if (hit) {
        const dist = (c.c - hit.stop) / c.c;
        pos = { entry: c.c, stop: hit.stop, size: Math.min((p.riskPct / 100) / dist, RISK.maxSpotFraction) };
      }
    }
    peak = Math.max(peak, equity);
    maxDd = Math.max(maxDd, 1 - equity / peak);
  }
  const wins = log.filter((x) => x.pnlPct > 0), losses = log.filter((x) => x.pnlPct <= 0);
  const gw = wins.reduce((a, x) => a + x.pnlPct, 0), gl = -losses.reduce((a, x) => a + x.pnlPct, 0);
  const first = candles[start], lastC = candles.at(-1);
  return {
    trades: log.length, winRate: log.length ? (wins.length / log.length) * 100 : 0,
    profitFactor: gl > 0 ? gw / gl : gw > 0 ? Infinity : 0, returnPct: (equity - 1) * 100, maxDrawdownPct: maxDd * 100,
    avgWinPct: wins.length ? gw / wins.length : 0, avgLossPct: losses.length ? -gl / losses.length : 0,
    days: first && lastC ? (lastC.t - first.t) / 86_400_000 : 0, log,
  };
}
