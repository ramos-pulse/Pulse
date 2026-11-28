// L'AGENT CHERCHEUR : invente, teste et améliore des stratégies sans arrêt (logique pure, testable).
//
// Pour ne pas se mentir, chaque stratégie est jugée HORS ÉCHANTILLON :
//  - elle est évaluée sur les 2/3 les plus anciens de l'historique (« entraînement »),
//  - puis sur le dernier tiers, qu'aucun réglage n'a « vu » (« validation »).
// Une stratégie qui ne gagne que sur l'entraînement a appris le passé par cœur : elle est rejetée.
// Les meilleures servent de parents : le chercheur les fait muter légèrement pour trouver mieux.
import { backtest, backtestRsi, type BacktestResult, type Candle, type Interval, type Params, type RsiParams, type SimOpts, SPOT_COOLDOWN_MS } from "./strategy.ts";
import { backtestSetup, describeSetup, isSetup, type Extra, type SetupFamily, type SetupParams } from "./setups.ts";

export type Family = "tendance" | "rsi" | SetupFamily;
export type BotKind = "spot" | "perps";

export interface Market { name: string; product: string; symbol: string; kind: BotKind; interval: Interval; feePct: number; hourlyCost: number; cap: number }

export interface Candidate {
  market: string;            // nom affiché, ex. « Spot SOL »
  product: string;           // historique Coinbase, ex. « SOL-USD »
  symbol: string;            // token (spot) ou marché perps (SOL, ETH, BTC)
  kind: BotKind;
  interval: Interval;        // 1 h, ou 15 min pour le scalping
  family: Family;
  params: Params | RsiParams | SetupParams;
}

export interface SegmentStats { trades: number; winRate: number; profitFactor: number; returnPct: number; maxDrawdownPct: number; meanPct?: number; sdPct?: number; luck?: number;
  periodsWon?: number } // 28/11 : nombre de tiers de l'historique gagnés (sur 3, le dernier = période jamais vue)
export interface Evaluation { train: SegmentStats; test: SegmentStats; score: number; verdict: "prometteuse" | "à surveiller" | "rejetée"; why: string }

const pick = <T>(rnd: () => number, list: readonly T[]): T => list[Math.floor(rnd() * list.length)]!;

export const SPACE = {
  tendance: { breakout: [12, 24, 36, 48, 72, 96], trailAtr: [2, 2.5, 3, 3.5, 4], minTrend: [0.5, 0.8, 1, 1.2, 1.5, 2] },
  rsi: { rsiPeriod: [7, 10, 14, 21], entry: [20, 25, 30, 35], exit: [45, 50, 55, 60, 65], smaPeriod: [50, 100, 150, 200], swingBars: [5, 10, 15, 20] },
  range: { bbPeriod: [14, 20, 30], bbK: [1.5, 2, 2.5], stopAtr: [1, 1.5, 2, 3], maxTrend: [0.5, 1, 1.5] },
  orb: { session: ["utc"], /* 28/11 : non-stop, les séances Europe / Wall Street ne jouent pas le week-end */ zoneMin: [15, 30, 60], target: [1, 1.5, 2, 3], window: [2, 4, 6] },
  vwap: { dev: [1.5, 2, 2.5, 3], stopAtr: [1, 1.5, 2], maxTrend: [0.5, 1, 1.5, 3] },
  squeeze: { bbPeriod: [20], bbK: [2], lookback: [50, 100, 200], pct: [0.05, 0.1, 0.2], trailAtr: [1.5, 2, 2.5, 3] },
  volume: { volMult: [2, 2.5, 3, 4], body: [0.6, 0.8, 1.2], trailAtr: [1.5, 2, 2.5, 3] },
  funding: { level: [0.00002, 0.00004, 0.00008], stopAtr: [1.5, 2, 3], hold: [8, 16, 32, 48] },
} as const;
/** Familles proposées selon le bot : le spot n'achète que (pas de range ni de funding). */
export const FAMILIES: Record<BotKind, Family[]> = {
  spot: ["tendance", "rsi", "orb", "vwap", "squeeze", "volume"],
  perps: ["tendance", "range", "orb", "vwap", "squeeze", "volume", "funding"],
};
/** Part des stratégies testées avec le filtre « heures actives » (pas d'entrée la nuit ni le week-end). */
export const HOURS_SHARE = 0; // 28/11 : Ramos veut des bots qui tradent 24 h/24, 7 j/7 — plus de variante « heures actives seulement »
/** Part des stratégies de tendance tirées en « achat sur repli » plutôt qu'en cassure. */
export const PULLBACK_SHARE = 0.4;

/** Réglages supplémentaires explorés quand la nervosité est « Nerveux » ou plus : cassures très courtes, stops serrés, RSI rapide. */
export const SPACE_FAST = {
  tendance: { breakout: [6, 8], trailAtr: [1.5], minTrend: [0.3] },
  rsi: { rsiPeriod: [5], entry: [40], exit: [] as number[], smaPeriod: [20], swingBars: [3] },
  range: { bbPeriod: [10], bbK: [1.2], stopAtr: [] as number[], maxTrend: [] as number[] },
  vwap: { dev: [1], stopAtr: [] as number[], maxTrend: [] as number[] },
  volume: { volMult: [1.6], body: [0.4], trailAtr: [1.2] },
  squeeze: { pct: [0.3], trailAtr: [1.2] },
} as const;
type Grid = Record<string, readonly (number | string)[]>;
type Space = Record<Family, Grid>;
/** Espace de recherche : normal, ou élargi aux réglages nerveux. Les listes restent triées (les mutations bougent d'un cran). */
export function space(fast = false): Space {
  if (!fast) return SPACE as unknown as Space;
  const merge = (a: Grid, b: Record<string, readonly number[]> = {}): Grid =>
    Object.fromEntries(Object.entries(a).map(([k, v]) => [k, typeof v[0] === "string" ? v : [...new Set([...(b[k] ?? []), ...(v as readonly number[])])].sort((x, y) => x - y)]));
  const F = SPACE_FAST as unknown as Record<string, Record<string, readonly number[]>>;
  return Object.fromEntries(Object.entries(SPACE).map(([f, g]) => [f, merge(g as Grid, F[f])])) as Space;
}

/**
 * Rythme d'une stratégie : 0 calme, 1 normal, 2 nerveux, 3 très nerveux.
 * Bougies de 15 min, cassures courtes et RSI rapide la rendent plus nerveuse (plus de trades).
 */
export function tempo(c: { interval?: string | null; family: Family; params: unknown }): number {
  const p = c.params as Record<string, unknown>;
  let t = 1 + (c.interval === "15m" ? 1 : 0);
  const b = Number(p.breakout), r = Number(p.rsiPeriod);
  if (c.family === "range") t += Number(p.bbPeriod) <= 14 ? 1 : 0;
  else if (c.family === "orb" || c.family === "volume") t += 1;            // plusieurs occasions par jour
  else if (c.family === "vwap") t += Number(p.dev) <= 1.5 ? 1 : 0;
  else if (c.family === "squeeze") t += Number(p.pct) >= 0.2 ? 1 : 0;
  else if (c.family === "funding") t -= 1;                                  // rare
  else if (c.family === "tendance") t += (b <= 12 ? 1 : b >= 48 ? -1 : 0) + (p.entry === "repli" ? 1 : 0);
  else t += r <= 7 ? 1 : r >= 21 ? -1 : 0;
  return Math.max(0, Math.min(3, t));
}

// ---------------------------------------------------------------------------------------------------
// RÉPARTITION INTELLIGENTE DU TEMPS (28/11) : le chercheur apprend de ses propres résultats.
// ---------------------------------------------------------------------------------------------------
/** Compteurs avec oubli progressif : n = stratégies testées, ok = non rejetées, last = dernier passage (marchés). */
export interface Tally { n: number; ok: number; last?: number }
export interface ResearchStats { family: Record<string, Tally>; market: Record<string, Tally>; math: Record<string, Tally>; idea?: Record<string, Tally> }
export const ALLOC = { decay: 0.995, floor: 0.05, prior: { n: 20, ok: 2 }, minMath: 0.15, maxMath: 0.5 };
export const emptyStats = (): ResearchStats => ({ family: {}, market: {}, math: {}, idea: {} });
/** Mathématicien (28/11) : réussite par type d'idée (tendance, range, compression…), par bot et unité de temps. */
export const ideaKey = (kind: BotKind, interval: Interval, idea: string) => `${kind}|${interval}|${idea}`;
export function recordIdeas(st: ResearchStats, kind: BotKind, interval: Interval, list: { idea: string; verdict: string }[]) {
  const by = new Map<string, { n: number; ok: number }>();
  for (const r of list) { const t = by.get(r.idea) ?? { n: 0, ok: 0 }; t.n++; if (r.verdict !== "rejetée") t.ok++; by.set(r.idea, t); }
  for (const [idea, t] of by) bump((st.idea ??= {}), ideaKey(kind, interval, idea), t.n, t.ok);
}
/** Chance qu'une idée du mathématicien soit essayée : selon sa réussite (8 % de réussite = toujours), jamais moins de 10 %. */
export const ideaChance = (st: ResearchStats, kind: BotKind, interval: Interval, idea: string) => Math.min(1, Math.max(0.1, yieldOf(st.idea?.[ideaKey(kind, interval, idea)]) / 0.08));
/** Variantes voisines d'une idée du mathématicien (sa théorie situe la zone, la grille trouve le bon réglage). */
export const MATH_GRID = 4;
export const familyKey = (kind: BotKind, interval: Interval, f: Family) => `${kind}|${interval}|${f}`;
export const marketKey = (m: Pick<Market, "product" | "kind" | "interval">) => `${m.product}|${m.kind}|${m.interval}`;
/** Taux de réussite lissé (un a priori de 2 réussites sur 20 évite de juger sur 3 essais). */
export const yieldOf = (t?: Tally) => ((t?.ok ?? 0) + ALLOC.prior.ok) / ((t?.n ?? 0) + ALLOC.prior.n);
function bump(rec: Record<string, Tally>, key: string, n: number, ok: number, now?: number) {
  const t = rec[key] ?? { n: 0, ok: 0 };
  rec[key] = { n: t.n * ALLOC.decay + n, ok: t.ok * ALLOC.decay + ok, ...(now != null ? { last: now } : t.last != null ? { last: t.last } : {}) };
}
/** Ajoute les résultats d'un cycle aux statistiques. */
export function recordCycle(st: ResearchStats, m: Market, rows: { family: Family; verdict: string; origin: string }[], now: number): ResearchStats {
  const okOf = (r: { verdict: string }) => r.verdict !== "rejetée" ? 1 : 0;
  bump(st.market, marketKey(m), rows.length, rows.reduce((s, r) => s + okOf(r), 0), now);
  const byFam = new Map<Family, { n: number; ok: number }>();
  for (const r of rows.filter((x) => x.origin !== "mathématicien")) { const t = byFam.get(r.family) ?? { n: 0, ok: 0 }; t.n++; t.ok += okOf(r); byFam.set(r.family, t); }
  for (const [f, t] of byFam) bump(st.family, familyKey(m.kind, m.interval, f), t.n, t.ok);
  const math = rows.filter((x) => x.origin === "mathématicien");
  if (math.length) bump(st.math, `${m.kind}|${m.interval}`, math.length, math.reduce((s, r) => s + okOf(r), 0));
  return st;
}
/** Poids des familles pour un marché : proportionnels au taux de réussite, jamais sous 5 % chacune. */
export function familyWeights(st: ResearchStats, kind: BotKind, interval: Interval, families: Family[]): Partial<Record<Family, number>> {
  const raw = families.map((f) => yieldOf(st.family[familyKey(kind, interval, f)]));
  const sum = raw.reduce((a, b) => a + b, 0) || 1;
  const free = Math.max(0, 1 - families.length * ALLOC.floor); // chaque famille a son plancher, le reste est partagé selon la réussite
  return Object.fromEntries(families.map((f, i) => [f, ALLOC.floor + free * (raw[i]! / sum)]));
}
/** Part du temps de calcul laissée au mathématicien : selon sa réussite comparée à celle du chercheur (15 à 50 %). */
export function mathShare(st: ResearchStats, kind: BotKind, interval: Interval): number {
  const fam = Object.entries(st.family).filter(([k]) => k.startsWith(`${kind}|${interval}|`)).reduce((a, [, t]) => ({ n: a.n + t.n, ok: a.ok + t.ok }), { n: 0, ok: 0 });
  const ratio = yieldOf(st.math[`${kind}|${interval}`]) / Math.max(1e-6, yieldOf(fam));
  return Math.min(ALLOC.maxMath, Math.max(ALLOC.minMath, ALLOC.maxMath * ratio));
}
/**
 * Marché du cycle : priorité = heures depuis le dernier passage × (0,5 + 5 × taux de réussite).
 * Le marché le plus « en retard » passe d'abord ; ceux qui trouvent reviennent plus souvent ; aucun n'est oublié.
 */
export function pickMarket<M extends Pick<Market, "product" | "kind" | "interval">>(pool: M[], st: ResearchStats, now: number, rnd: () => number): M {
  let best = pool[0]!, bestP = -1;
  for (const m of pool) {
    const t = st.market[marketKey(m)];
    const hours = t?.last != null ? (now - t.last) / 3_600_000 : 48; // jamais étudié : prioritaire
    const p = (hours + 0.01) * (0.5 + 5 * yieldOf(t)) * (1 + rnd() * 0.05); // petit aléa : départage les égalités
    if (p > bestP) { bestP = p; best = m; }
  }
  return best;
}
function weightedPick<T extends string>(rnd: () => number, items: T[], w: Partial<Record<T, number>>): T {
  const tot = items.reduce((s, x) => s + (w[x] ?? ALLOC.floor), 0);
  let r = rnd() * tot;
  for (const x of items) { r -= w[x] ?? ALLOC.floor; if (r <= 0) return x; }
  return items[items.length - 1]!;
}

/** Une stratégie au hasard dans l'espace de recherche. Le RSI n'existe qu'en spot (achat uniquement). */
export function randomCandidate(rnd: () => number, m: Market, fast = false, withFunding = false, weights?: Partial<Record<Family, number>>): Candidate {
  // tendance la moitié du temps (la famille la plus éprouvée), sinon une des autres familles permises pour ce bot
  const others = FAMILIES[m.kind].filter((f) => f !== "tendance" && (f !== "funding" || withFunding));
  // 28/11 : avec des statistiques, chaque famille reçoit sa part selon son taux de réussite récent (plancher 5 %)
  const family: Family = weights ? weightedPick(rnd, ["tendance", ...others], weights) : rnd() < 0.35 ? "tendance" : pick(rnd, others);
  return { market: m.name, product: m.product, symbol: m.symbol, kind: m.kind, interval: m.interval, family, params: randomParams(rnd, family, space(fast), m.interval) };
}

function randomParams(rnd: () => number, family: Family, S: Space = SPACE as unknown as Space, interval: Interval = "1h"): Params | RsiParams | SetupParams {
  const hours = family !== "rsi" && family !== "funding" && rnd() < HOURS_SHARE ? { hours: "actives" as const } : {};
  if (family === "tendance") {
    const t = S.tendance as Record<string, readonly number[]>;
    return { breakout: pick(rnd, t.breakout!), trailAtr: pick(rnd, t.trailAtr!), minTrend: pick(rnd, t.minTrend!), ...(rnd() < PULLBACK_SHARE ? { entry: "repli" as const } : {}), ...hours };
  }
  if (family !== "rsi") {
    const g = S[family];
    const out = Object.fromEntries(Object.entries(g).map(([k, v]) => [k, pick(rnd, v)])) as Record<string, number | string>;
    if (family === "orb" && interval === "1h") out.zoneMin = 60; // en bougies d'1 h, la zone fait au moins 1 bougie
    return { ...out, ...hours } as unknown as SetupParams;
  }
  const r = S.rsi as Record<string, readonly number[]>;
  const entry = pick(rnd, r.entry!);
  const exits = r.exit!.filter((x) => x > entry + 10);
  return { rsiPeriod: pick(rnd, r.rsiPeriod!), entry, exit: pick(rnd, exits.length ? exits : [entry + 20]), smaPeriod: pick(rnd, r.smaPeriod!), swingBars: pick(rnd, r.swingBars!), riskPct: 1, naive: false };
}

/** Petite variation d'une bonne stratégie : un seul réglage bouge d'un cran. */
export function mutate(rnd: () => number, c: Candidate, fast = false): Candidate {
  const grid = space(fast)[c.family];
  const keys = Object.keys(grid);
  if ((c.params as unknown as { hours?: string }).hours && rnd() < 0.5) { // une ancienne stratégie « heures actives » : on retire ce filtre (24 h/24)
    const p = { ...(c.params as unknown as Record<string, unknown>) };
    if (p.hours) delete p.hours; // jamais ajoutée : trading 24 h/24
    return { ...c, params: p as unknown as Candidate["params"] };
  }
  const k = pick(rnd, keys);
  const list = grid[k]!;
  const cur = (c.params as unknown as Record<string, number | string>)[k]!;
  let i = list.indexOf(cur);
  if (i < 0) i = Math.floor(list.length / 2);
  const j = Math.max(0, Math.min(list.length - 1, i + (rnd() < 0.5 ? -1 : 1)));
  const params = { ...c.params, [k]: list[j] } as Candidate["params"];
  if (c.family === "orb" && c.interval === "1h") (params as unknown as Record<string, number>).zoneMin = 60;
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
  const mean = log.length ? log.reduce((a, t) => a + t.pnlPct, 0) / log.length : 0;
  const sd = log.length > 1 ? Math.sqrt(log.reduce((a, t) => a + (t.pnlPct - mean) ** 2, 0) / (log.length - 1)) : 0;
  return {
    trades: log.length, winRate: log.length ? (wins.length / log.length) * 100 : 0,
    profitFactor: gl > 0 ? gw / gl : gw > 0 ? 99 : 0, returnPct: (eq - 1) * 100, maxDrawdownPct: dd * 100,
    meanPct: Math.round(mean * 10000) / 10000, sdPct: Math.round(sd * 10000) / 10000,
  };
}

/** Évalue une stratégie : entraînement (2/3 anciens) puis validation (1/3 récent, jamais vu). */
/**
 * Contexte de simulation, pour rejouer EXACTEMENT ce que fait le bot réel : spot = moitié vendue à +1,5 R et filtre BTC ;
 * perps = stop au prix d'entrée à +1,5 R ; pause après perte et taille selon la volatilité pour les deux.
 */
export interface EvalContext { blockedAt?: (t: number) => boolean; extra?: Extra }
export function simulate(c: Candidate, candles: Candle[], m: Market, ctx: EvalContext = {}): BacktestResult {
  const o: SimOpts = { allowShort: m.kind === "perps", feePct: m.feePct, hourlyCost: m.hourlyCost, leverageCap: m.cap,
    partial: m.kind === "spot" ? "half" : "breakeven", ...(m.kind === "spot" && ctx.blockedAt ? { blockedAt: ctx.blockedAt } : {}),
    ...(m.kind === "spot" ? { cooldownMs: SPOT_COOLDOWN_MS } : {}) }; // même pause qu'en réel
  if (c.family === "rsi") return backtestRsi(candles, c.params as RsiParams, m.feePct, o);
  if (isSetup(c.family)) return backtestSetup(c.family, candles, c.params as SetupParams, { ...o, extra: ctx.extra });
  return backtest(candles, { ...o, params: c.params as Params });
}
/** Exigences de validation (28/11) : 8 trades sur la période jamais vue pour « prometteuse », et 2 tiers gagnés sur 3. */
export const VALID = { minTestTrades: 8, periodMinTrades: 3, periodMinPF: 1.1 };
export function evaluate(c: Candidate, candles: Candle[], m: Market, ctx: EvalContext = {}): Evaluation {
  const r = simulate(c, candles, m, ctx);
  const split = candles[Math.floor(candles.length * 2 / 3)]?.t ?? Infinity;
  const train = segment(r.log.filter((t) => t.t < split));
  const test = segment(r.log.filter((t) => t.t >= split));
  // 28/11 : validation sur 3 périodes. Un tiers « gagné » = au moins 3 trades et PF ≥ 1,1 : une stratégie doit gagner
  // la période jamais vue ET au moins un des deux tiers de l'entraînement (sinon son passé repose sur un seul coup)
  const third = candles[Math.floor(candles.length / 3)]?.t ?? -Infinity;
  const won = (g: SegmentStats) => g.trades >= VALID.periodMinTrades && g.profitFactor >= VALID.periodMinPF;
  const periodsWon = [segment(r.log.filter((t) => t.t < third)), segment(r.log.filter((t) => t.t >= third && t.t < split)), test].filter(won).length;
  test.periodsWon = periodsWon;
  let verdict: Evaluation["verdict"] = "rejetée", why: string, score: number;
  if (train.trades < 3 || test.trades < 2) { why = "trop peu de trades pour juger"; score = -100; }
  else if (train.profitFactor < 1.05) { why = "perd déjà sur l'entraînement"; score = -50 + train.profitFactor; }
  else if (test.profitFactor < 1) { why = "gagne sur le passé mais perd sur la période jamais vue (sur-optimisation)"; score = -20 + test.profitFactor; }
  else {
    // récompense le gain sur la période jamais vue, pénalise les grosses baisses et les résultats fondés sur 2-3 trades
    const confidence = Math.min(1, test.trades / 8);
    score = (test.returnPct / Math.max(test.maxDrawdownPct, 2)) * confidence + Math.min(train.profitFactor, 3) * 0.2;
    if (test.profitFactor >= 1.3 && train.profitFactor >= 1.15 && test.trades >= VALID.minTestTrades && won(test) && periodsWon >= 2) { verdict = "prometteuse"; why = `gagne sur le passé ET sur la période jamais vue (${periodsWon}/3 périodes gagnées)`; }
    else { verdict = "à surveiller"; why = test.trades < VALID.minTestTrades ? `positive mais encore fragile (${test.trades} trades sur la période jamais vue, ${VALID.minTestTrades} exigés)`
      : periodsWon < 2 ? "positive mais fragile : ne gagne que sur une seule des 3 périodes" : "positive mais encore fragile (marge faible)"; }
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
  if (isSetup(c.family)) return `${iv} · ${describeSetup(c.family, c.params as SetupParams, c.kind)}`;
  const p = c.params as Params;
  const h = p.hours === "actives" ? ", heures actives seulement" : "";
  const span = c.interval === "15m" ? `${p.breakout} bougies (${Math.round(p.breakout / 4)} h)` : `${p.breakout} h`;
  if (p.entry === "repli") return `${iv} · tendance : achat sur repli vers la moyenne 20 (tendance de ${span}), force ≥ ${p.minTrend} ATR, stop suiveur ${p.trailAtr} ATR${c.kind === "perps" ? ", long et short" : ""}${h}`;
  return `${iv} · tendance : cassure ${span}, force ≥ ${p.minTrend} ATR, stop suiveur ${p.trailAtr} ATR${c.kind === "perps" ? ", long et short" : ""}${h}`;
}

/** Générateur pseudo-aléatoire reproductible (graine = numéro de cycle de recherche). */
export function seeded(seed: number): () => number {
  let s = (Math.abs(Math.floor(seed)) % 2147483646) + 1;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}
