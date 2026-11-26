// L'AGENT CHERCHEUR : invente, teste et améliore des stratégies sans arrêt (logique pure, testable).
//
// Pour ne pas se mentir, chaque stratégie est jugée HORS ÉCHANTILLON :
//  - elle est évaluée sur les 2/3 les plus anciens de l'historique (« entraînement »),
//  - puis sur le dernier tiers, qu'aucun réglage n'a « vu » (« validation »).
// Une stratégie qui ne gagne que sur l'entraînement a appris le passé par cœur : elle est rejetée.
// Les meilleures servent de parents : le chercheur les fait muter légèrement pour trouver mieux.
import { backtest, backtestRsi, type BacktestResult, type Candle, type Interval, type Params, type RsiParams } from "./strategy.ts";

export type Family = "tendance" | "rsi";
export type BotKind = "spot" | "perps";

export interface Market { name: string; product: string; symbol: string; kind: BotKind; interval: Interval; feePct: number; hourlyCost: number; cap: number }

export interface Candidate {
  market: string;            // nom affiché, ex. « Spot SOL »
  product: string;           // historique Coinbase, ex. « SOL-USD »
  symbol: string;            // token (spot) ou marché perps (SOL, ETH, BTC)
  kind: BotKind;
  interval: Interval;        // 1 h, ou 15 min pour le scalping
  family: Family;
  params: Params | RsiParams;
}

export interface SegmentStats { trades: number; winRate: number; profitFactor: number; returnPct: number; maxDrawdownPct: number }
export interface Evaluation { train: SegmentStats; test: SegmentStats; score: number; verdict: "prometteuse" | "à surveiller" | "rejetée"; why: string }

const pick = <T>(rnd: () => number, list: readonly T[]): T => list[Math.floor(rnd() * list.length)]!;

export const SPACE = {
  tendance: { breakout: [12, 24, 36, 48, 72, 96], trailAtr: [2, 2.5, 3, 3.5, 4], minTrend: [0.5, 0.8, 1, 1.2, 1.5, 2] },
  rsi: { rsiPeriod: [7, 10, 14, 21], entry: [20, 25, 30, 35], exit: [45, 50, 55, 60, 65], smaPeriod: [50, 100, 150, 200], swingBars: [5, 10, 15, 20] },
} as const;

/** Une stratégie au hasard dans l'espace de recherche. Le RSI n'existe qu'en spot (achat uniquement). */
export function randomCandidate(rnd: () => number, m: Market): Candidate {
  const family: Family = m.kind === "spot" && rnd() < 0.5 ? "rsi" : "tendance";
  return { market: m.name, product: m.product, symbol: m.symbol, kind: m.kind, interval: m.interval, family, params: randomParams(rnd, family) };
}

function randomParams(rnd: () => number, family: Family): Params | RsiParams {
  if (family === "tendance") {
    const t = SPACE.tendance;
    return { breakout: pick(rnd, t.breakout), trailAtr: pick(rnd, t.trailAtr), minTrend: pick(rnd, t.minTrend) };
  }
  const r = SPACE.rsi;
  const entry = pick(rnd, r.entry);
  const exits = r.exit.filter((x) => x > entry + 10);
  return { rsiPeriod: pick(rnd, r.rsiPeriod), entry, exit: pick(rnd, exits.length ? exits : [entry + 20]), smaPeriod: pick(rnd, r.smaPeriod), swingBars: pick(rnd, r.swingBars), riskPct: 1, naive: false };
}

/** Petite variation d'une bonne stratégie : un seul réglage bouge d'un cran. */
export function mutate(rnd: () => number, c: Candidate): Candidate {
  const space = SPACE[c.family] as Record<string, readonly number[]>;
  const keys = Object.keys(space);
  const k = pick(rnd, keys);
  const list = space[k]!;
  const cur = (c.params as unknown as Record<string, number>)[k]!;
  let i = list.indexOf(cur);
  if (i < 0) i = Math.floor(list.length / 2);
  const j = Math.max(0, Math.min(list.length - 1, i + (rnd() < 0.5 ? -1 : 1)));
  const params = { ...c.params, [k]: list[j] } as Params | RsiParams;
  if (c.family === "rsi") { const p = params as RsiParams; if (p.exit <= p.entry + 5) p.exit = Math.min(95, p.entry + 15); }
  return { ...c, params };
}

/** Signature unique pour ne jamais tester deux fois la même stratégie. */
export function candidateKey(c: Candidate): string {
  const p = c.params as unknown as Record<string, unknown>;
  return `${c.product}|${c.kind}|${c.interval}|${c.family}|` + Object.keys(p).sort().filter((k) => k !== "riskPct" && k !== "naive").map((k) => `${k}=${p[k]}`).join(",");
}

function segment(log: BacktestResult["log"]): SegmentStats {
  let eq = 1, peak = 1, dd = 0;
  for (const t of log) { eq *= 1 + t.pnlPct / 100; peak = Math.max(peak, eq); dd = Math.max(dd, 1 - eq / peak); }
  const wins = log.filter((t) => t.pnlPct > 0);
  const gw = wins.reduce((s, t) => s + t.pnlPct, 0), gl = -log.filter((t) => t.pnlPct <= 0).reduce((s, t) => s + t.pnlPct, 0);
  return {
    trades: log.length, winRate: log.length ? (wins.length / log.length) * 100 : 0,
    profitFactor: gl > 0 ? gw / gl : gw > 0 ? 99 : 0, returnPct: (eq - 1) * 100, maxDrawdownPct: dd * 100,
  };
}

/** Évalue une stratégie : entraînement (2/3 anciens) puis validation (1/3 récent, jamais vu). */
export function evaluate(c: Candidate, candles: Candle[], m: Market): Evaluation {
  const r = c.family === "rsi"
    ? backtestRsi(candles, c.params as RsiParams, m.feePct)
    : backtest(candles, { allowShort: m.kind === "perps", feePct: m.feePct, hourlyCost: m.hourlyCost, leverageCap: m.cap, params: c.params as Params });
  const split = candles[Math.floor(candles.length * 2 / 3)]?.t ?? Infinity;
  const train = segment(r.log.filter((t) => t.t < split));
  const test = segment(r.log.filter((t) => t.t >= split));
  let verdict: Evaluation["verdict"] = "rejetée", why: string, score: number;
  if (train.trades < 3 || test.trades < 2) { why = "trop peu de trades pour juger"; score = -100; }
  else if (train.profitFactor < 1.05) { why = "perd déjà sur l'entraînement"; score = -50 + train.profitFactor; }
  else if (test.profitFactor < 1) { why = "gagne sur le passé mais perd sur la période jamais vue (sur-optimisation)"; score = -20 + test.profitFactor; }
  else {
    // récompense le gain sur la période jamais vue, pénalise les grosses baisses et les résultats fondés sur 2-3 trades
    const confidence = Math.min(1, test.trades / 8);
    score = (test.returnPct / Math.max(test.maxDrawdownPct, 2)) * confidence + Math.min(train.profitFactor, 3) * 0.2;
    if (test.profitFactor >= 1.3 && train.profitFactor >= 1.15 && test.trades >= 4) { verdict = "prometteuse"; why = "gagne sur le passé ET sur la période jamais vue"; }
    else { verdict = "à surveiller"; why = "positive mais encore fragile (peu de trades ou marge faible)"; }
  }
  return { train, test, score: Math.round(score * 1000) / 1000, verdict, why };
}

/** Résumé lisible des réglages d'une stratégie. */
export function describe(c: Pick<Candidate, "family" | "params" | "kind"> & { interval?: Interval }): string {
  const iv = c.interval === "15m" ? "scalping 15 min" : "bougies 1 h";
  if (c.family === "rsi") {
    const p = c.params as RsiParams;
    return `${iv} · RSI(${p.rsiPeriod}) sous ${p.entry} au-dessus de la MM${p.smaPeriod}, sortie RSI > ${p.exit}, stop creux ${p.swingBars} bougies`;
  }
  const p = c.params as Params;
  const span = c.interval === "15m" ? `${p.breakout} bougies (${Math.round(p.breakout / 4)} h)` : `${p.breakout} h`;
  return `${iv} · tendance : cassure ${span}, force ≥ ${p.minTrend} ATR, stop suiveur ${p.trailAtr} ATR${c.kind === "perps" ? ", long et short" : ""}`;
}

/** Générateur pseudo-aléatoire reproductible (graine = numéro de cycle de recherche). */
export function seeded(seed: number): () => number {
  let s = (Math.abs(Math.floor(seed)) % 2147483646) + 1;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}
