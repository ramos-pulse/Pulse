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

/** `candles` = produit Coinbase utilisé pour l'historique horaire du jeton. */
export const TOKENS = [
  { symbol: "SOL", mint: SOL_MINT, decimals: 9, candles: "SOL-USD" },
  { symbol: "JUP", mint: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN", decimals: 6, candles: "JUP-USD" },
  { symbol: "BONK", mint: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263", decimals: 5, candles: "BONK-USD" },
  { symbol: "WBTC", mint: "3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh", decimals: 8, candles: "BTC-USD" },
  { symbol: "WETH", mint: "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs", decimals: 8, candles: "ETH-USD" },
] as const;

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

export const PERPS_ASSETS = [{ asset: "SOL", mint: SOL_MINT, candles: "SOL-USD" }] as const;
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

/** Perps : collatéral et levier pour risquer RISK.perTrade du capital, levier plafonné. */
export function perpsSizing(equity: number, usdc: number, entry: number, stop: number, risk = RISK.perTrade) {
  const dist = Math.abs(entry - stop) / entry;
  if (!(dist > 0)) return null;
  const notional = (equity * risk) / dist;
  let collateral = Math.max(PERPS_RULES.minCollateralUsd, notional / PERPS_RULES.maxLeverage);
  if (collateral > usdc) return null;
  let leverage = notional / collateral;
  if (leverage < 1.1) { leverage = 1.1; collateral = notional / leverage; }
  if (collateral < PERPS_RULES.minCollateralUsd) return null; // capital trop faible pour respecter le risque
  return { collateral, leverage: Math.min(leverage, PERPS_RULES.maxLeverage), notional };
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
export function riskGate(mem: Memory, valueUsd: number, now: number): string | null {
  const today = dayKey(now);
  if (mem.day !== today || !mem.dayStartValue) { mem.day = today; mem.dayStartValue = valueUsd; }
  if (valueUsd <= mem.dayStartValue * (1 - RISK.dailyLoss)) return `perte du jour > ${RISK.dailyLoss * 100} % : plus d'entrée aujourd'hui`;
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
export function backtest(candles: Candle[], o: { allowShort: boolean; feePct: number; hourlyCost?: number; leverageCap?: number; params?: Params }): BacktestResult {
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
      if (sig.side) {
        const dist = Math.abs(sig.price - sig.stop) / sig.price;
        const size = Math.min(RISK.perTrade / dist, o.leverageCap ?? RISK.maxSpotFraction); // fraction du capital exposée
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
