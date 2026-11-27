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

import { isSetup, PERPS_ONLY, sanitizeSetup, type SetupFamily, type SetupParams } from "./setups.ts";

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
  // ajoutés le 27/11/2026 : adresses vérifiées (Coinbase, DexTools, Bitquery) ; revérifiées sur Jupiter avant chaque achat
  { symbol: "ORCA", mint: "orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE", decimals: 6, candles: "ORCA-USD", verify: true },
  { symbol: "HNT", mint: "hntyVP6YFm1Hg25TN9WGLqM12b8TQmcknKrdu1oxWux", decimals: 8, candles: "HNT-USD", verify: true },
  { symbol: "TRUMP", mint: "6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN", decimals: 6, candles: "TRUMP-USD", verify: true },
  { symbol: "PENGU", mint: "2zMMhcVQEXDtdE6vsFS7S7D5oUodfJHE8vd1gnBouauv", decimals: 6, candles: "PENGU-USD", verify: true },
] as const;

/** Un token tradable : liste fixe ci-dessus + tokens choisis par le sélectionneur ou l'agent nouveaux tokens. */
export interface TokenInfo { symbol: string; mint: string; decimals: number; candles: string; verify: boolean; extra?: "selection" | "nouveau"; seenAt?: number; active?: boolean }
let EXTRA: TokenInfo[] = [];
/**
 * Tokens ajoutés par les agents (chargés depuis la base à chaque appel). Un token retiré de la sélection reste connu tant
 * qu'il peut être en portefeuille : le bot doit toujours pouvoir l'évaluer et le revendre.
 */
export function setExtraTokens(list: TokenInfo[]) {
  EXTRA = list.filter((t) => !TOKENS.some((x) => x.mint === t.mint || x.symbol === t.symbol)).filter((t, i, a) => a.findIndex((y) => y.mint === t.mint || y.symbol === t.symbol) === i);
}
export const allTokens = (): readonly TokenInfo[] => [...TOKENS, ...EXTRA];

/** Unités de temps des bougies : 1 h (suivi de tendance classique) ou 15 min (scalping prudent). */
export type Interval = "1h" | "15m";
export const INTERVAL_MS: Record<Interval, number> = { "1h": 3_600_000, "15m": 900_000 };
export const asInterval = (v: unknown): Interval => (v === "15m" ? "15m" : "1h");

/** Un « plan » choisi par le chercheur : quel token, quelle stratégie, quels réglages, quelle unité de temps. */
export type Confidence = "nouvelle" | "confirmée";
export type SpotFamily = "tendance" | "rsi" | Exclude<SetupFamily, "range" | "funding">;
export interface SpotPlan { symbol: string; family: SpotFamily; params: Params | RsiParams | SetupParams; interval: Interval; source: string; score: number; confidence: Confidence }
export interface PerpsPlan { asset: string; family?: "tendance" | SetupFamily; params: Params | SetupParams; interval: Interval; source: string; score: number; confidence: Confidence }
/** Les bots apprennent du chercheur : une stratégie pas encore confirmée en réel est tradée avec 75 % du risque normal. */
export const PROBATION_RISK = 0.75;
export const riskFactor = (c: Confidence | undefined) => (c === "confirmée" ? 1 : PROBATION_RISK);
const asConfidence = (v: unknown): Confidence => (v === "confirmée" ? "confirmée" : "nouvelle");

/** Réglages de tendance. entry = "repli" : entrée sur repli vers la moyenne 20 au lieu d'une cassure. */
export interface Params { breakout: number; trailAtr: number; minTrend: number; entry?: "repli"; hours?: "actives" }
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
export interface Candle { t: number; o: number; h: number; l: number; c: number; v?: number } // t = ouverture, en ms ; v = volume

/**
 * SEUILS ADAPTÉS À L'UNITÉ DE TEMPS : une bougie de 15 min bouge environ 2 fois moins qu'une bougie d'1 h (racine de 4).
 * Avant, le filtre « marché trop calme » (0,4 %), la sortie d'une position qui stagne (96 h) et la pause après une perte (1 h)
 * étaient les mêmes en 15 min : les stratégies rapides étaient presque toujours bloquées.
 */
export const TF = {
  "1h": { minAtrPct: 0.004, maxAtrPct: 0.05, maxHoldHours: 96, cooldownMs: 60 * 60_000, hoursPerBar: 1 },
  "15m": { minAtrPct: 0.002, maxAtrPct: 0.025, maxHoldHours: 24, cooldownMs: 15 * 60_000, hoursPerBar: 0.25 },
} as const;
/** Unité de temps déduite des bougies elles-mêmes (écart entre les deux dernières). */
export const barMsOf = (c: Candle[]) => (c.length > 1 ? c[c.length - 1]!.t - c[c.length - 2]!.t : 3_600_000);
export const ivOfMs = (ms: number): Interval => (ms <= 900_000 ? "15m" : "1h");
export const tfOf = (c: Candle[]) => TF[ivOfMs(barMsOf(c))];
/** Pause après une perte, selon l'unité de temps de la position. */
export const cooldownMs = (iv: Interval | undefined) => TF[iv ?? "1h"].cooldownMs;

/**
 * HEURES ACTIVES (filtre « heures creuses », testé par le chercheur) : du lundi au vendredi, 7 h – 21 h UTC.
 * La nuit et le week-end, les volumes baissent et les fausses cassures sont plus fréquentes.
 */
export function activeHour(t: number): boolean {
  const d = new Date(t), h = d.getUTCHours(), wd = d.getUTCDay();
  return wd >= 1 && wd <= 5 && h >= 7 && h < 21;
}

/**
 * TAILLE SELON LA VOLATILITÉ : quand l'ATR actuel dépasse nettement sa médiane récente, le marché s'agite
 * (les stops sautent plus souvent) : le risque est réduit. 1 = normal, 0,7 = agité, 0,5 = très agité.
 */
export function volScale(c: Candle[], period = 14, lookback = 200): number {
  if (c.length < period + 30) return 1;
  const a = atr(c, period).slice(-lookback).map((x, i, arr) => x / c[c.length - arr.length + i]!.c);
  const now = a.at(-1)!, med = [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)]!;
  if (!(med > 0)) return 1;
  return now > 2 * med ? 0.5 : now > 1.5 * med ? 0.7 : 1;
}

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
  const T = tfOf(candles);
  if (atrPct < T.minAtrPct) return empty(`marché trop calme (ATR ${(atrPct * 100).toFixed(2)} % < ${(T.minAtrPct * 100).toFixed(1)} %)`);
  if (atrPct > T.maxAtrPct) return empty(`marché trop agité (ATR ${(atrPct * 100).toFixed(2)} %)`);
  if (P.hours === "actives" && !activeHour(last.t + barMsOf(candles))) return empty("heures creuses (nuit ou week-end) : pas d'entrée");

  const strength = Math.abs(fast - slow) / a; // écart des moyennes en nombre d'ATR = force de la tendance
  const window = candles.slice(-P.breakout - 1, -1);
  const hi = Math.max(...window.map((x) => x.h));
  const lo = Math.min(...window.map((x) => x.l));
  const ref = closes[Math.max(0, closes.length - 1 - S.momentumBars)]!;
  const momentum = last.c / ref - 1;

  if (strength < P.minTrend) return empty(`tendance trop faible (${strength.toFixed(1)} ATR < ${P.minTrend})`);
  if (P.entry === "repli") {
    // ACHAT SUR REPLI : dans une tendance en place, le prix revient toucher sa moyenne 20 puis repart dans le sens de la tendance
    const m20 = ema(closes, PULLBACK.ema), m = m20.at(-1)!, mPrev = m20.at(-2)!, prev = candles.at(-2)!;
    if (fast > slow && slow > slowBefore && last.c > slow && prev.l <= mPrev && last.c > m && last.c > prev.c)
      return { side: "long", reason: `repli sur la moyenne ${PULLBACK.ema} puis rebond, en tendance haussière (force ${strength.toFixed(1)})`, price: last.c, atr: a, stop: last.c - S.stopAtr * a, candleTime: last.t, score: momentum };
    if (allowShort && fast < slow && slow < slowBefore && last.c < slow && prev.h >= mPrev && last.c < m && last.c < prev.c)
      return { side: "short", reason: `remontée sur la moyenne ${PULLBACK.ema} puis rechute, en tendance baissière (force ${strength.toFixed(1)})`, price: last.c, atr: a, stop: last.c + S.stopAtr * a, candleTime: last.t, score: -momentum };
    return empty(`tendance ${fast > slow ? "haussière" : "baissière"}, pas de repli sur la moyenne ${PULLBACK.ema} (${fmt(m)})`);
  }
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

export const PULLBACK = { ema: 20 };

// ---------------------------------------------------------------------------------------------------
// RANGE (perps) : marché sans tendance. Le prix sort des bandes de Bollinger → on parie sur le retour au milieu.
// Long sous la bande basse, short au-dessus de la bande haute ; objectif = la moyenne ; stop fixe à k ATR ;
// sortie forcée après 2 × la période si rien ne s'est passé.
// ---------------------------------------------------------------------------------------------------
export interface RangeParams { bbPeriod: number; bbK: number; stopAtr: number; maxTrend: number; hours?: "actives" }
export const RANGE_RULES = { minAtrPct: 0.0015, maxHoldMult: 2 };
export function sanitizeRange(t: unknown): RangeParams | null {
  if (!t || typeof t !== "object") return null;
  const x = t as Partial<RangeParams>;
  const n = Number(x.bbPeriod), k = Number(x.bbK), s = Number(x.stopAtr), m = Number(x.maxTrend);
  if (![n, k, s, m].every(Number.isFinite)) return null;
  return { bbPeriod: Math.round(Math.min(60, Math.max(8, n))), bbK: Math.min(3.5, Math.max(1, k)), stopAtr: Math.min(5, Math.max(0.5, s)), maxTrend: Math.min(3, Math.max(0.2, m)), ...(x.hours === "actives" ? { hours: "actives" as const } : {}) };
}
export const isRange = (p: unknown): p is RangeParams => !!p && typeof p === "object" && "bbPeriod" in (p as object);

/** Bandes de Bollinger sur la dernière bougie : milieu (moyenne), haut, bas. */
export function bollinger(closes: number[], n: number, k: number) {
  const w = closes.slice(-n), mid = w.reduce((a, x) => a + x, 0) / w.length;
  const sd = Math.sqrt(w.reduce((a, x) => a + (x - mid) ** 2, 0) / w.length);
  return { mid, up: mid + k * sd, lo: mid - k * sd };
}

export function rangeSignal(candles: Candle[], allowShort: boolean, P: RangeParams): Signal {
  const S = STRATEGY;
  const last = candles[candles.length - 1];
  const empty = (reason: string): Signal => ({ side: null, reason, price: last?.c ?? 0, atr: 0, stop: 0, candleTime: last?.t ?? 0, score: 0 });
  if (!last || candles.length < S.emaSlow + 5) return empty(`historique insuffisant (${candles.length} bougies)`);
  const closes = candles.map((x) => x.c);
  const a = atr(candles, S.atrPeriod).at(-1)!;
  if (a / last.c < RANGE_RULES.minAtrPct) return empty(`marché trop calme même pour un range (ATR ${((a / last.c) * 100).toFixed(2)} %)`);
  if (a / last.c > tfOf(candles).maxAtrPct) return empty(`marché trop agité (ATR ${((a / last.c) * 100).toFixed(2)} %)`);
  if (P.hours === "actives" && !activeHour(last.t + barMsOf(candles))) return empty("heures creuses (nuit ou week-end) : pas d'entrée");
  const strength = Math.abs(ema(closes, S.emaFast).at(-1)! - ema(closes, S.emaSlow).at(-1)!) / a;
  if (strength > P.maxTrend) return empty(`marché en tendance (force ${strength.toFixed(1)} > ${P.maxTrend}) : pas de range`);
  const b = bollinger(closes, P.bbPeriod, P.bbK);
  const room = Math.abs(b.mid - last.c) / last.c;
  if (last.c < b.lo) return { side: "long", reason: `range : sous la bande basse (${fmt(b.lo)}), retour attendu vers ${fmt(b.mid)}`, price: last.c, atr: a, stop: last.c - P.stopAtr * a, candleTime: last.t, score: room };
  if (allowShort && last.c > b.up) return { side: "short", reason: `range : au-dessus de la bande haute (${fmt(b.up)}), retour attendu vers ${fmt(b.mid)}`, price: last.c, atr: a, stop: last.c + P.stopAtr * a, candleTime: last.t, score: room };
  return empty(`range : prix dans les bandes (${fmt(b.lo)} – ${fmt(b.up)})`);
}

/** Sortie d'une position range : objectif = retour à la moyenne, ou trop longtemps sans résultat. */
export function rangeExit(candles: Candle[], side: Side, P: RangeParams, heldBars: number): "objectif" | "range_temps" | null {
  const b = bollinger(candles.map((x) => x.c), P.bbPeriod, P.bbK), c = candles.at(-1)!.c;
  if (side === "long" ? c >= b.mid : c <= b.mid) return "objectif";
  if (heldBars >= P.bbPeriod * RANGE_RULES.maxHoldMult) return "range_temps";
  return null;
}

/** Backtest range : même signal et mêmes sorties que le bot réel, frais et portage inclus, risque 1 % par trade. */
export function backtestRange(candles: Candle[], P: RangeParams, o: { allowShort: boolean; feePct: number; hourlyCost: number; leverageCap: number; hoursPerBar: number }): BacktestResult {
  let equity = 1, peak = 1, maxDd = 0;
  const log: BacktestResult["log"] = [];
  let pos: { side: Side; entry: number; stop: number; size: number; i: number } | null = null;
  const start = STRATEGY.emaSlow + 5;
  for (let i = start; i < candles.length; i++) {
    const c = candles[i]!;
    const win = candles.slice(Math.max(0, i - 400), i + 1);
    if (pos) {
      let exit: number | null = null, reason = "";
      if (pos.side === "long" ? c.l <= pos.stop : c.h >= pos.stop) { exit = pos.side === "long" ? Math.min(c.o, pos.stop) : Math.max(c.o, pos.stop); reason = "stop_loss"; }
      else { const r = rangeExit(win, pos.side, P, i - pos.i); if (r) { exit = c.c; reason = r; } }
      if (exit !== null) {
        const move = pos.side === "long" ? exit / pos.entry - 1 : 1 - exit / pos.entry;
        const pnl = pos.size * (move - 2 * o.feePct - o.hourlyCost * (i - pos.i) * o.hoursPerBar);
        equity *= 1 + pnl;
        log.push({ side: pos.side, entry: pos.entry, exit, pnlPct: pnl * 100, reason, t: c.t });
        pos = null;
      }
    } else {
      const sig = rangeSignal(win, o.allowShort, P);
      if (sig.side) {
        const dist = Math.abs(sig.price - sig.stop) / sig.price;
        pos = { side: sig.side, entry: c.c, stop: sig.stop, size: Math.min(0.01 / dist, o.leverageCap), i };
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

/** Stop suiveur : ne recule jamais. `best` = meilleure clôture depuis l'entrée (la plus haute en long, la plus basse en short). */
export function trailStop(side: Side, current: number, best: number, atrNow: number, P: Params = DEFAULT_PARAMS): number {
  const chandelier = side === "long" ? best - P.trailAtr * atrNow : best + P.trailAtr * atrNow;
  return side === "long" ? Math.max(current, chandelier) : Math.min(current, chandelier);
}

export type ExitReason = "stop_loss" | "trailing_stop" | "time_stop";

/** Sortie vérifiée à chaque tick (prix en direct) contre le stop calculé sur les bougies. */
export function exitCheck(p: { side: Side; entry: number; price: number; stop: number; initialRisk: number; openedAt: number; interval?: Interval }, now: number): ExitReason | null {
  const hit = p.side === "long" ? p.price <= p.stop : p.price >= p.stop;
  if (hit) {
    const locked = p.side === "long" ? p.stop >= p.entry : p.stop <= p.entry;
    return locked ? "trailing_stop" : "stop_loss";
  }
  const hours = (now - p.openedAt) / 3_600_000;
  const r = p.initialRisk > 0 ? ((p.side === "long" ? p.price - p.entry : p.entry - p.price) / p.initialRisk) : 0;
  if (hours >= TF[p.interval ?? "1h"].maxHoldHours && r < STRATEGY.minProgressR) return "time_stop";
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
/**
 * Levier maximum que permet un stop : le stop doit TOUJOURS être touché bien avant la liquidation.
 * Sur Jupiter, liquidation quand le collatéral restant < 0,2 % de la taille, soit une perte ≈ 1/levier − 0,2 % (− frais).
 * On garde une grosse marge : le prix de liquidation est au moins 3 fois plus loin que le stop.
 */
export const LIQ = { maintenance: 0.002, fees: 0.002, safety: 1 / 3 }; // liquidation au moins 3 fois plus loin que le stop
export function stopSafeLeverage(dist: number): number {
  return 1 / (dist / LIQ.safety + LIQ.maintenance + LIQ.fees);
}

/**
 * Taille d'une position perps : la perte au stop = le risque choisi.
 * Petit capital : Jupiter exige 10 $ de collatéral au minimum. Si la taille voulue est plus petite, on prend le minimum
 * (10 $ à x1,1) SEULEMENT si la perte au stop reste sous `maxRisk` (le plafond du niveau d'agressivité).
 */
export function perpsSizing(equity: number, usdc: number, entry: number, stop: number, risk = RISK.perTrade, maxLevWanted: number = PERPS_RULES.maxLeverage, maxRisk = risk) {
  const dist = Math.abs(entry - stop) / entry;
  if (!(dist > 0) || !(equity > 0)) return null;
  const maxLev = Math.max(1.1, Math.min(maxLevWanted, stopSafeLeverage(dist))); // jamais de levier qui liquiderait avant le stop
  let notional = (equity * risk) / dist;
  let collateral = Math.max(PERPS_RULES.minCollateralUsd, notional / maxLev);
  if (collateral > usdc) return null;
  let leverage = notional / collateral;
  if (leverage < 1.1) { // la taille voulue est sous le minimum de Jupiter : position minimale, si le risque reste acceptable
    leverage = 1.1; collateral = PERPS_RULES.minCollateralUsd; notional = collateral * leverage;
    if ((notional * dist) / equity > maxRisk + 1e-9) return null;
  }
  return { collateral, leverage: Math.min(leverage, maxLev), notional, risk: (notional * dist) / equity };
}

// ---------------------------------------------------------------------------------------------------
// Réglages du bot perps : mode agressif et biais longs / shorts
// ---------------------------------------------------------------------------------------------------
export type PerpsMode = "normal" | "agressif";
export interface PerpsConfig { mode: PerpsMode; aggr: number; maxLev: number; pilotAggressive: boolean; bias: number; trend: Params | null; source?: string; autopilot: boolean;
  plans: PerpsPlan[]; plan: PerpsPlan | null; // plans : une stratégie par marché (SOL, ETH, BTC) ; plan = la première (compatibilité)
  maxPositions: number; vaultPct: number; partialTp: boolean; extraSoft: boolean } // bias : -100 = shorts seulement, 0 = équilibré, +100 = longs seulement

/** Mode agressif : risque doublé (plafond 3 %), levier jusqu'à x5, perte max 8 %/jour, trade même sans réglage validé. */
export const AGGRESSIVE = { riskMult: 2, maxRisk: 0.03, maxLeverage: 5, dailyLoss: 0.08 };

/** Leviers maximum proposés dans l'app (Jupiter : 250x maximum à l'ouverture). */
export const LEVERAGES = [3, 5, 10, 100, 250] as const;
/**
 * Barre d'agressivité du bot perps, de la plus faible à la plus forte.
 * riskMult : multiplie le risque par trade choisi par le cerveau ; maxRisk : plafond ; dailyLoss : perte max du jour.
 * À partir de « Agressif », le bot trade aussi quand aucun réglage n'a été validé sur 60 jours.
 */
export const AGGR_LEVELS = [
  { name: "Prudent", riskMult: 0.5, maxRisk: 0.01, dailyLoss: 0.03 },
  { name: "Normal", riskMult: 1, maxRisk: 0.02, dailyLoss: RISK.dailyLoss },
  { name: "Dynamique", riskMult: 1.5, maxRisk: 0.025, dailyLoss: 0.065 },
  { name: "Agressif", riskMult: 2, maxRisk: 0.03, dailyLoss: 0.08 },
  { name: "Très agressif", riskMult: 3, maxRisk: 0.045, dailyLoss: 0.12 },
] as const;
export const AGGR_NORMAL = 1, AGGR_AGGRESSIVE = 3;

/**
 * Niveau réellement appliqué. Prudence : en pilote automatique, le niveau est plafonné à « Normal »,
 * sauf si le mode agressif du chercheur est activé.
 */
export function effectiveAggr(c: Pick<PerpsConfig, "aggr" | "autopilot" | "pilotAggressive">): number {
  return c.autopilot && !c.pilotAggressive ? Math.min(c.aggr, AGGR_NORMAL) : c.aggr;
}

export function loadPerpsConfig(raw: unknown): PerpsConfig {
  const o = (raw && typeof raw === "object" ? raw : {}) as Partial<PerpsConfig>;
  const bias = Number(o.bias);
  const a = Number(o.aggr);
  const aggr = Number.isFinite(a) ? Math.round(Math.min(AGGR_LEVELS.length - 1, Math.max(0, a))) : o.mode === "agressif" ? AGGR_AGGRESSIVE : AGGR_NORMAL; // ancien réglage « agressif » conservé
  const lev = Number(o.maxLev);
  const maxLev = (LEVERAGES as readonly number[]).includes(lev) ? lev : PERPS_RULES.maxLeverage;
  return { mode: aggr >= AGGR_AGGRESSIVE ? "agressif" : "normal", aggr, maxLev, pilotAggressive: o.pilotAggressive === true,
    bias: Number.isFinite(bias) ? Math.round(Math.min(100, Math.max(-100, bias))) : 0,
    trend: sanitizeTrend(o.trend), ...(typeof o.source === "string" ? { source: o.source.slice(0, 120) } : {}),
    autopilot: o.autopilot === true, extraSoft: o.extraSoft === true, ...plansOf(o), ...protections(o) };
}

/** Une stratégie par marché, 3 au maximum. Reprend l'ancien champ `plan` s'il n'y a pas encore de liste. */
function plansOf(o: Partial<PerpsConfig>): { plans: PerpsPlan[]; plan: PerpsPlan | null } {
  const raw = Array.isArray(o.plans) ? o.plans : o.plan ? [o.plan] : [];
  const plans: PerpsPlan[] = [];
  for (const x of raw) { const p = sanitizePerpsPlan(x); if (p && !plans.some((q) => q.asset === p.asset) && plans.length < 3) plans.push(p); }
  return { plans, plan: plans[0] ?? null };
}

export function sanitizePerpsPlan(raw: unknown): PerpsPlan | null {
  if (!raw || typeof raw !== "object") return null;
  const x = raw as Partial<PerpsPlan>;
  if (!PERPS_ASSETS.some((a) => a.asset === x.asset)) return null;
  const fam = isSetup(x.family) ? x.family : isRange(x.params) ? "range" : null;
  const params = fam ? sanitizeSetup(fam, x.params) : sanitizeTrend(x.params);
  if (!params) return null;
  return { asset: String(x.asset), ...(fam ? { family: fam } : {}), params, interval: asInterval(x.interval), source: String(x.source ?? "").slice(0, 120), score: Number(x.score) || 0, confidence: asConfidence(x.confidence) };
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
export interface Pending { kind: "buy" | "sell" | "partial" | "open" | "close"; sig: string; at: number; mint?: string; asset?: string; usdcBefore?: number; rawBefore?: string; reason?: string; draft?: Position;
  expectedPrice?: number; expectedUsd?: number } // prix / USDC cotés : contrôle anti-sandwich après exécution

/** Une position (spot : clé = mint du token ; perps : clé = marché SOL/ETH/BTC). */
export interface Position {
  key: string; symbol: string; side: Side;
  entry?: number; stop?: number; best?: number; initialRisk?: number; stopCandle?: number; openedAt?: number;
  strategy?: SpotStrategy | SetupFamily | "nouveau"; posParams?: Params | RsiParams | SetupParams; posInterval?: Interval; source?: string;
  target?: number;           // objectif de prix (familles « à objectif » : ORB, VWAP, funding)
  liqAtEntry?: number;       // liquidité du token à l'entrée (spot) : sortie d'urgence si elle s'effondre
  liqCheckedAt?: number;
  costUsd?: number;          // spot : USDC encore engagés (après une vente partielle, la moitié)
  collateralUsd?: number;    // perps : collatéral déposé à l'ouverture
  sizeUsd?: number;          // perps : taille de la position
  lastValueUsd?: number;     // perps : dernière valeur vue (collatéral + PnL)
  pubkey?: string;
  partialDone?: boolean;     // prise de bénéfices partielle déjà faite (ou stop remonté au prix d'entrée)
  missing?: number;          // nombre de ticks où la position n'a pas été vue (on attend 2 ticks avant de la croire fermée)
  why?: string;              // raison de l'entrée (affichée dans « Pourquoi ce trade ? »)
  live?: { price: number; pnlPct: number; at: number };
}
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
  positions?: Record<string, Position>; // toutes les positions ouvertes
  vault?: number;            // coffre à gains (USD) : jamais retradé
  curve?: { t: number; v: number }[]; // courbe du capital (un point par heure, 30 jours)
  lastCandleBy?: Record<string, number>; // perps : dernière bougie analysée par marché
  lastUsdc?: number;         // USDC vus au tick précédent (stops on-chain, détection des dépôts et retraits)
  lastSol?: number;          // SOL vus au tick précédent (détection des dépôts et retraits)
  solWarnDay?: string;       // dernière alerte « réserve de SOL basse »
  jitoMissAt?: number;
  fresh?: Record<string, string>; // agent nouveaux tokens : tokens déjà achetés (mint → jour), jamais rachetés       // dernier envoi privé (Jito) non exécuté : voie normale pendant 15 min
  errStreak?: number;        // erreurs consécutives (chien de garde)
}

/**
 * DÉPÔTS ET RETRAITS : de l'argent qui arrive ou part du wallet sans trade n'est ni un gain ni une perte.
 * Renvoie le montant en $ (positif = dépôt, négatif = retrait) si un transfert est détecté, sinon 0.
 * Seuil : au moins 1 $ et 3 % de la valeur, pour ignorer les frais de réseau et les arrondis.
 */
export const TRANSFER = { minUsd: 1, minPct: 0.03 };
export function detectTransfer(mem: Memory, usdc: number, sol: number, solPrice: number, valueUsd: number): number {
  if (mem.lastUsdc == null) return 0;
  const d = usdc - mem.lastUsdc + (sol - (mem.lastSol ?? sol)) * (solPrice || 0);
  return Math.abs(d) >= Math.max(TRANSFER.minUsd, valueUsd * TRANSFER.minPct) ? d : 0;
}
/** Applique un transfert : la perte du jour et la courbe repartent du nouveau solde (le point de départ est ajusté par l'appelant). */
export function applyTransfer(mem: Memory, d: number) {
  if (mem.dayStartValue) mem.dayStartValue = Math.max(0.01, mem.dayStartValue + d);
  for (const pt of mem.curve ?? []) pt.v = Math.round((pt.v + d) * 100) / 100;
}

/** Ajoute un point à la courbe du capital (au plus un par heure, 30 jours gardés). */
export function sampleCurve(mem: Memory, valueUsd: number, now: number) {
  const c = (mem.curve ??= []);
  if (!(valueUsd > 0)) return;
  const last = c.at(-1);
  if (last && now - last.t < 3_600_000) { last.v = Math.round(valueUsd * 100) / 100; return; }
  c.push({ t: now, v: Math.round(valueUsd * 100) / 100 });
  if (c.length > 720) c.splice(0, c.length - 720);
}

/**
 * Reprend l'ancien format (une seule position décrite à plat dans la mémoire) dans la liste des positions.
 * Aucune position réelle n'est perdue : sa protection (stop) et sa stratégie sont gardées.
 */
export function migratePositions(mem: Memory, bot: { kind: string; position_mint?: string | null; position_asset?: string | null; position_side?: string | null; position_pubkey?: string | null; entry_price?: number | null }) {
  if (mem.positions) return mem.positions;
  mem.positions = {};
  const key = bot.kind === "spot" ? bot.position_mint : bot.position_side ? bot.position_asset ?? mem.asset : null;
  if (key) {
    mem.positions[key] = {
      key, symbol: mem.asset ?? (bot.kind === "spot" ? key.slice(0, 4) : key), side: (bot.kind === "spot" ? "long" : bot.position_side === "short" ? "short" : "long"),
      entry: bot.entry_price ?? undefined, stop: mem.stop, best: mem.best, initialRisk: mem.initialRisk, stopCandle: mem.stopCandle, openedAt: mem.openedAt,
      strategy: mem.strategy, posParams: mem.posParams, posInterval: mem.posInterval, source: mem.source, costUsd: mem.costUsd, pubkey: bot.position_pubkey ?? undefined, live: mem.live,
    };
  }
  for (const k of ["stop", "best", "initialRisk", "stopCandle", "openedAt", "strategy", "posParams", "posInterval", "source", "costUsd", "openValueUsd", "asset", "side", "live"] as const) delete mem[k];
  return mem.positions;
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

/** Réserve de SOL pour les frais de transaction : sans SOL, le bot ne peut même plus vendre ou fermer. */
export const SOL_RESERVE = { warn: 0.01 };
/** Alerte une fois par jour si la réserve de SOL est trop basse. Renvoie le texte de l'alerte, ou null. */
export function solReserveAlert(mem: Memory, sol: number, now: number, who: string): string | null {
  if (sol >= SOL_RESERVE.warn) return null;
  const today = dayKey(now);
  if (mem.solWarnDay === today) return null;
  mem.solWarnDay = today;
  return `${who} : réserve de SOL basse (${sol.toFixed(4)} SOL) — ajoute environ 0,02 SOL au portefeuille du bot, sinon il ne pourra plus payer les frais de ses transactions.`;
}

/**
 * Vente : la marge de prix (slippage) s'adapte à la liquidité. Un token très liquide (impact faible) n'a besoin que
 * de 0,5 % de marge ; on n'élargit jusqu'à 1,5 % que si la vente déplace vraiment le prix. Une marge plus serrée
 * laisse moins de place aux sandwichs.
 */
export function exitSlippageBps(impactPct: number): number {
  const impactBps = Math.max(0, impactPct) * 10_000;
  return Math.round(Math.min(RULES.exitSlippageBps, Math.max(RULES.spotSlippageBps, RULES.spotSlippageBps + 3 * impactBps)));
}
/** Groupes de tokens qui bougent ensemble : 2 positions du même groupe = presque le même pari. */
export const GROUPS: Record<string, string[]> = {
  grandes: ["SOL", "WBTC", "WETH"],
  memes: ["BONK", "WIF", "POPCAT", "PENGU", "TRUMP"],
  defi: ["JUP", "JTO", "PYTH", "RAY", "ORCA", "RENDER", "HNT"],
};
export const groupOf = (symbol: string) => Object.entries(GROUPS).find(([, l]) => l.includes(symbol))?.[0] ?? symbol;
/** Sortie d'urgence si la liquidité d'un token tombe sous 50 % de celle de l'entrée (vérifiée toutes les 10 min). */
export const LIQUIDITY = { collapse: 0.5, checkMs: 10 * 60_000 };

/** Seuil d'arrêt de mission : 30 % de la valeur de départ (au moins 1 $), au lieu de 5 $ fixes. */
export const FLOOR = { pct: 0.3, minUsd: 1 };
export const floorOf = (startValue: number | null | undefined, fallback: number) =>
  Number(startValue) > 0 ? Math.max(FLOOR.minUsd, Number(startValue) * FLOOR.pct) : fallback;

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
  avgWinPct: number; avgLossPct: number; days: number; log: { side: Side; entry: number; exit: number; pnlPct: number; reason: string; t: number; t0?: number }[];
}

/**
 * Options communes des backtests, pour qu'ils rejouent EXACTEMENT ce que font les bots réels :
 *  - partial : prise de bénéfices à +1,5 R (« half » = spot, la moitié vendue ; « breakeven » = perps, stop au prix d'entrée)
 *  - pause après une perte (durée selon l'unité de temps), taille réduite quand le marché s'agite (volScale)
 *  - blockedAt : filtre de marché (ex. BTC qui chute) qui bloque les entrées du spot à cet instant
 */
export interface SimOpts { allowShort: boolean; feePct: number; hourlyCost?: number; leverageCap?: number; risk?: number; bias?: number;
  partial?: "half" | "breakeven" | null; blockedAt?: (t: number) => boolean; noCooldown?: boolean; noVolScale?: boolean }

/** Résultat final d'une simulation (log des trades → statistiques). */
export function summarize(log: BacktestResult["log"], equityCurve: { maxDd: number; equity: number }, first?: Candle, lastC?: Candle): BacktestResult {
  const wins = log.filter((x) => x.pnlPct > 0), losses = log.filter((x) => x.pnlPct <= 0);
  const gw = wins.reduce((s, x) => s + x.pnlPct, 0), gl = -losses.reduce((s, x) => s + x.pnlPct, 0);
  return {
    trades: log.length, winRate: log.length ? (wins.length / log.length) * 100 : 0,
    profitFactor: gl > 0 ? gw / gl : gw > 0 ? Infinity : 0, returnPct: (equityCurve.equity - 1) * 100, maxDrawdownPct: equityCurve.maxDd * 100,
    avgWinPct: wins.length ? gw / wins.length : 0, avgLossPct: losses.length ? -gl / losses.length : 0,
    days: first && lastC ? (lastC.t - first.t) / 86_400_000 : 0, log,
  };
}

/** feePct = coût par côté (frais + slippage), en fraction. hourlyCost = coût de portage par heure (perps). */
export function backtest(candles: Candle[], o: SimOpts & { params?: Params }): BacktestResult {
  const P = o.params ?? DEFAULT_PARAMS;
  const T = tfOf(candles);
  let equity = 1, peak = 1, maxDd = 0;
  const log: BacktestResult["log"] = [];
  let pos: { side: Side; entry: number; stop: number; best: number; risk: number; openedAt: number; size: number; partial: boolean } | null = null;
  let cooldownUntil = 0;
  const atrs = atr(candles, STRATEGY.atrPeriod);
  const close = (exit: number, reason: string, t: number, frac = 1) => {
    const move = perpsChange(pos!.side, pos!.entry, exit);
    const hours = (t - pos!.openedAt) / 3_600_000;
    const pnl = pos!.size * frac * (move - 2 * o.feePct - (o.hourlyCost ?? 0) * hours);
    equity *= 1 + pnl;
    log.push({ side: pos!.side, entry: pos!.entry, exit, pnlPct: pnl * 100, reason, t, t0: pos!.openedAt });
    return pnl;
  };

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
        if ((c.t - pos.openedAt) / 3_600_000 >= T.maxHoldHours && r < STRATEGY.minProgressR) { exit = c.c; reason = "time_stop"; }
      }
      if (exit !== null) {
        const pnl = close(exit, reason, c.t);
        if (pnl < 0 && !o.noCooldown) cooldownUntil = c.t + T.cooldownMs;
        pos = null;
      } else {
        // prise de bénéfices à +1,5 R pendant la bougie, comme le bot réel
        const target = pos.side === "long" ? pos.entry + PARTIAL.atR * pos.risk : pos.entry - PARTIAL.atR * pos.risk;
        if (o.partial && !pos.partial && (pos.side === "long" ? c.h >= target : c.l <= target)) {
          pos.partial = true;
          if (o.partial === "half") { close(target, "prise_partielle", c.t, PARTIAL.fraction); pos.size *= 1 - PARTIAL.fraction; }
          pos.stop = pos.side === "long" ? Math.max(pos.stop, pos.entry) : Math.min(pos.stop, pos.entry);
        }
        pos.best = pos.side === "long" ? Math.max(pos.best, c.c) : Math.min(pos.best, c.c);
        pos.stop = trailStop(pos.side, pos.stop, pos.best, atrs[i]!, P);
      }
    }
    if (!pos && c.t >= cooldownUntil && !o.blockedAt?.(c.t)) {
      const win = candles.slice(Math.max(0, i - 400), i + 1);
      const sig = trendSignal(win, o.allowShort, P);
      const mult = sig.side ? sideMult(o.bias ?? 0, sig.side) * (o.noVolScale ? 1 : volScale(win)) : 0;
      if (sig.side && mult > 0) {
        const dist = Math.abs(sig.price - sig.stop) / sig.price;
        const size = Math.min(((o.risk ?? RISK.perTrade) * mult) / dist, o.leverageCap ?? RISK.maxSpotFraction); // fraction du capital exposée
        pos = { side: sig.side, entry: sig.price, stop: sig.stop, best: sig.price, risk: Math.abs(sig.price - sig.stop), openedAt: c.t, size, partial: false };
      }
    }
    peak = Math.max(peak, equity);
    maxDd = Math.max(maxDd, 1 - equity / peak);
  }
  return summarize(log, { equity, maxDd }, candles[STRATEGY.emaSlow + 5], candles.at(-1));
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
export interface SpotConfig { strategy: SpotStrategy; rsi: RsiParams; trend: Params | null; source?: string; autopilot: boolean; plans: SpotPlan[]; swapAuto: boolean; researchAggressive: boolean; nerve: number;
  extraSoft: boolean;     // mode « extra souple » : critères très assouplis, risque divisé par 2
  researchPerps: number; // barre du chercheur : part des cycles de recherche pour les perps (0 = tout pour le spot, 100 = tout pour les perps)
  newTokens: boolean; // agent nouveaux tokens : achète (toute petite mise) les tokens tout juste lancés qui passent les garde-fous
  maxPositions: number; vaultPct: number; partialTp: boolean; marketFilter: boolean;
  breakerPct: number; breakerBase: number | null; breakerTrippedAt: number | null }

/** Barre de nervosité des agents : 0 calme, 1 normal (tout est permis, comme avant), 2 nerveux, 3 très nerveux. */
export const NERVE_LEVELS = ["Calme", "Normal", "Nerveux", "Très nerveux"] as const;

/** Réglages de tendance personnalisés (appliqués depuis le chercheur) ; null = le cerveau choisit chaque jour. */
export function sanitizeTrend(t: unknown): Params | null {
  if (!t || typeof t !== "object") return null;
  const x = t as Partial<Params>;
  const b = Number(x.breakout), a = Number(x.trailAtr), m = Number(x.minTrend);
  if (![b, a, m].every(Number.isFinite)) return null;
  return { breakout: Math.round(Math.min(168, Math.max(6, b))), trailAtr: Math.min(6, Math.max(1, a)), minTrend: Math.min(4, Math.max(0, m)), ...(x.entry === "repli" ? { entry: "repli" as const } : {}), ...(x.hours === "actives" ? { hours: "actives" as const } : {}) };
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
    autopilot: o.autopilot === true, plans: sanitizeSpotPlans(o.plans), swapAuto: o.swapAuto !== false,
    researchAggressive: o.researchAggressive === true, newTokens: o.newTokens === true, extraSoft: o.extraSoft === true, researchPerps: Number.isFinite(Number(o.researchPerps)) ? Math.round(Math.min(100, Math.max(0, Number(o.researchPerps)))) : 50, nerve: Number.isFinite(Number(o.nerve)) ? Math.round(Math.min(3, Math.max(0, Number(o.nerve)))) : 1,
    ...protections(o),
    marketFilter: o.marketFilter !== false,
    breakerPct: (BREAKER_STEPS as readonly number[]).includes(Number(o.breakerPct)) ? Number(o.breakerPct) : BREAKER_DEFAULT,
    breakerBase: Number(o.breakerBase) > 0 ? Number(o.breakerBase) : null, breakerTrippedAt: Number(o.breakerTrippedAt) > 0 ? Number(o.breakerTrippedAt) : null };
}

// ---------------------------------------------------------------------------------------------------
// Protections communes aux deux bots
// ---------------------------------------------------------------------------------------------------
/** Nombre de positions simultanées (1 à 3) et part de chaque gain mise au coffre (jamais retradée). */
export const VAULT_STEPS = [0, 25, 50, 75] as const;
export const VAULT_DEFAULT = 25;
/** Prise de bénéfices partielle : à +1,5 R (1,5 fois le risque initial), vendre la moitié et remonter le stop au prix d'entrée. */
export const PARTIAL = { atR: 1.5, fraction: 0.5 };
/** Risque total ouvert (toutes positions d'un bot) : la perte si TOUS les stops sont touchés ne dépasse pas ce plafond. */
export const TOTAL_RISK = { spot: 0.03, perpsMult: 1.5 };
/** Disjoncteur global : les deux bots s'arrêtent si leur valeur totale baisse de plus de X % (0 = coupé). */
export const BREAKER_STEPS = [0, 10, 15, 20, 30] as const;
export const BREAKER_DEFAULT = 15;
export function protections(o: { maxPositions?: unknown; vaultPct?: unknown; partialTp?: unknown }) {
  const n = Math.round(Number(o.maxPositions));
  return {
    maxPositions: n >= 1 && n <= 3 ? n : 3,
    vaultPct: (VAULT_STEPS as readonly number[]).includes(Number(o.vaultPct)) ? Number(o.vaultPct) : VAULT_DEFAULT,
    partialTp: o.partialTp !== false,
  };
}
/** Part du gain envoyée au coffre. Le coffre ne peut pas dépasser l'USDC réellement présent. */
export function addToVault(vault: number | undefined, pnlUsd: number, pct: number): number {
  return Math.max(0, (vault ?? 0) + (pnlUsd > 0 ? (pnlUsd * pct) / 100 : 0));
}
/** Capital tradable : tout, sauf le coffre. */
export function tradable(valueUsd: number, usdc: number, vault: number | undefined) {
  const v = Math.min(vault ?? 0, usdc);
  return { equity: Math.max(0, valueUsd - v), usdc: Math.max(0, usdc - v), vault: v };
}

/**
 * Filtre de marché du spot : pas d'achat quand le Bitcoin chute fort (presque tout chute avec lui).
 * Bloque si BTC a perdu ≥ 6 % en 24 h, ou ≥ 3 % en 24 h en étant sous sa moyenne mobile 200 h.
 */
export const MARKET_FILTER = { hardDrop: -0.06, softDrop: -0.03, ema: 200 };
export function marketFilter(btc: Candle[]): { blocked: boolean; change24h: number; belowEma: boolean } {
  if (btc.length < 30) return { blocked: false, change24h: 0, belowEma: false };
  const last = btc.at(-1)!.c, dayAgo = btc[Math.max(0, btc.length - 25)]!.c;
  const change24h = last / dayAgo - 1;
  const belowEma = btc.length >= MARKET_FILTER.ema ? last < ema(btc.map((x) => x.c), MARKET_FILTER.ema).at(-1)! : false;
  return { blocked: change24h <= MARKET_FILTER.hardDrop || (change24h <= MARKET_FILTER.softDrop && belowEma), change24h, belowEma };
}

export function sanitizeSpotPlans(raw: unknown): SpotPlan[] {
  if (!Array.isArray(raw)) return [];
  const SYMBOLS = new Set<string>(allTokens().map((t) => t.symbol));
  const out: SpotPlan[] = [];
  for (const x of raw as Partial<SpotPlan>[]) {
    if (out.length >= 3) break; // 3 plans maximum, comptés après avoir écarté les tokens inconnus
    if (!x || !SYMBOLS.has(String(x.symbol))) continue;
    const family: SpotFamily = x.family === "rsi" ? "rsi" : isSetup(x.family) && !PERPS_ONLY.includes(x.family) ? x.family as SpotFamily : "tendance";
    const params = family === "rsi" ? sanitizeRsi(x.params as Partial<RsiParams>) : family === "tendance" ? sanitizeTrend(x.params) : sanitizeSetup(family, x.params);
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

/** Backtest de la stratégie RSI, frais inclus (feePct par côté), avec prise partielle, pause après perte et filtre BTC comme en réel. */
export function backtestRsi(candles: Candle[], p: RsiParams, feePct: number, o: Pick<SimOpts, "partial" | "blockedAt" | "noCooldown"> = {}): BacktestResult {
  const closes = candles.map((x) => x.c);
  const r = rsiSeries(closes, p.rsiPeriod), s = smaSeries(closes, p.smaPeriod);
  const exitLevel = p.naive ? NAIVE_EXIT : p.exit;
  const T = tfOf(candles);
  let equity = 1, peak = 1, maxDd = 0, cooldownUntil = 0;
  const log: BacktestResult["log"] = [];
  let pos: { entry: number; stop: number; size: number; risk: number; partial: boolean; t0: number } | null = null;
  const start = Math.max(p.smaPeriod, p.rsiPeriod) + 2;
  const close = (exit: number, reason: string, t: number, frac = 1) => {
    const pnl = pos!.size * frac * ((exit - pos!.entry) / pos!.entry - 2 * feePct);
    equity *= 1 + pnl;
    log.push({ side: "long", entry: pos!.entry, exit, pnlPct: pnl * 100, reason, t, t0: pos!.t0 });
    return pnl;
  };
  for (let i = start; i < candles.length; i++) {
    const c = candles[i]!;
    if (pos) {
      let exit: number | null = null, reason = "";
      if (c.l <= pos.stop) { exit = Math.min(c.o, pos.stop); reason = pos.stop >= pos.entry ? "trailing_stop" : "stop_loss"; }
      else if (r[i]! > exitLevel) { exit = c.c; reason = "rsi_exit"; }
      if (exit !== null) {
        const pnl = close(exit, reason, c.t);
        if (pnl < 0 && !o.noCooldown) cooldownUntil = c.t + T.cooldownMs;
        pos = null;
      } else if (o.partial && !pos.partial && c.h >= pos.entry + PARTIAL.atR * pos.risk) {
        pos.partial = true;
        if (o.partial === "half") { close(pos.entry + PARTIAL.atR * pos.risk, "prise_partielle", c.t, PARTIAL.fraction); pos.size *= 1 - PARTIAL.fraction; }
        pos.stop = Math.max(pos.stop, pos.entry);
      }
    } else if (c.t >= cooldownUntil && !o.blockedAt?.(c.t)) {
      const hit = rsiEntryAt(candles, r, s, i, p);
      if (hit) {
        const dist = (c.c - hit.stop) / c.c;
        pos = { entry: c.c, stop: hit.stop, size: Math.min((p.riskPct / 100) / dist, RISK.maxSpotFraction), risk: c.c - hit.stop, partial: false, t0: c.t };
      }
    }
    peak = Math.max(peak, equity);
    maxDd = Math.max(maxDd, 1 - equity / peak);
  }
  return summarize(log, { equity, maxDd }, candles[start], candles.at(-1));
}

/**
 * Barre du chercheur : choisit le bot étudié à ce cycle. `perpsPct` = part des cycles pour les perps (0 à 100).
 * Tirage reproductible par cycle (même résultat pour un même cycle), sinon chaque bot garde au moins ses marchés.
 */
export function researchSide(cycle: number, perpsPct: number): "spot" | "perps" {
  if (perpsPct <= 0) return "spot";
  if (perpsPct >= 100) return "perps";
  const x = Math.abs(Math.sin(cycle * 12.9898) * 43758.5453) % 1;
  return x < perpsPct / 100 ? "perps" : "spot";
}

/** Mode « extra souple » : chaque trade ne prend que la moitié du risque normal (les stratégies sont moins prouvées). */
export const EXTRA_SOFT = { riskMult: 0.5, minTestTrades: 3, minTestPF: 1.0, maxTestDD: 25 };
