// L'AGENT MATHÉMATICIEN : au lieu de tirer des réglages au hasard, il MESURE le marché avec des outils statistiques
// et en déduit des stratégies, qu'il propose au chercheur.
//
// Règle d'honnêteté : il n'analyse QUE la partie « entraînement » de l'historique (les 2/3 les plus anciens).
// Le chercheur juge ensuite ses propositions sur la période jamais vue, avec exactement les mêmes critères
// que ses propres idées : une jolie théorie qui ne gagne pas hors échantillon est rejetée.
//
// Outils :
//  - ratio de variance de Lo-MacKinlay VR(q) : > 1 les mouvements se prolongent (tendance), < 1 ils se corrigent (retour à la moyenne) ;
//    avec un test z pour savoir si l'effet est réel ou du hasard (|z| > 1,96 ⇒ significatif à 95 %) ;
//  - exposant de Hurst (variance agrégée) : H > 0,5 marché à mémoire de tendance, H < 0,5 marché qui revient à la moyenne ;
//  - autocorrélation des rendements à 1 bougie ;
//  - demi-vie du retour à la moyenne (processus d'Ornstein-Uhlenbeck, régression de l'écart à la moyenne) ;
//  - quantiles empiriques : profondeur des replis pendant les tendances (stop suiveur), niveaux de RSI réellement extrêmes.
import { space, SPACE, type Candidate, type Market } from "./research.ts";
import { atr, ema, rsiSeries, STRATEGY, type Candle, type Params, type RsiParams } from "./strategy.ts";

export type Regime = "tendance" | "retour à la moyenne" | "hasard";
export interface MathInsight {
  regime: Regime; hurst: number; ac1: number; halfLife: number | null;
  vr: { q: number; vr: number; z: number }[]; bestQ: number; significant: boolean; bars: number; note: string;
}
export interface Proposal { candidate: Candidate; rationale: string }

const mean = (a: number[]) => a.reduce((s, x) => s + x, 0) / (a.length || 1);
const variance = (a: number[]) => { const m = mean(a); return a.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, a.length - 1); };
export function quantile(a: number[], p: number): number {
  const s = a.filter(Number.isFinite).sort((x, y) => x - y);
  if (!s.length) return NaN;
  const i = (s.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i);
  return s[lo]! + (s[hi]! - s[lo]!) * (i - lo);
}
/** Le cran de la grille de recherche le plus proche d'une valeur calculée. */
export const snap = (x: number, grid: readonly number[]) => grid.reduce((b, g) => (Math.abs(g - x) < Math.abs(b - x) ? g : b), grid[0]!);
const r3 = (x: number) => Math.round(x * 1000) / 1000;

export const logReturns = (c: Candle[]) => c.slice(1).map((x, i) => Math.log(x.c / c[i]!.c));

/** Ratio de variance de Lo-MacKinlay (sommes chevauchantes) et sa statistique z (hypothèse : marche au hasard). */
export function varianceRatio(r: number[], q: number): { vr: number; z: number } {
  const T = r.length, v1 = variance(r);
  if (T < q * 4 || v1 <= 0) return { vr: 1, z: 0 };
  const m = mean(r), sums: number[] = [];
  let s = 0;
  for (let i = 0; i < T; i++) { s += r[i]! - m; if (i >= q) s -= r[i - q]! - m; if (i >= q - 1) sums.push(s); }
  const vq = sums.reduce((a, x) => a + x * x, 0) / sums.length;
  const vr = vq / (q * v1);
  const phi = (2 * (2 * q - 1) * (q - 1)) / (3 * q * T);
  return { vr, z: (vr - 1) / Math.sqrt(phi) };
}

/** Exposant de Hurst par variance agrégée : Var(somme de q rendements) ∝ q^(2H). */
export function hurst(r: number[], qs = [1, 2, 4, 8, 16, 32]): number {
  const xs: number[] = [], ys: number[] = [];
  const m = mean(r);
  for (const q of qs) {
    if (r.length < q * 8) continue;
    const sums: number[] = [];
    let s = 0;
    for (let i = 0; i < r.length; i++) { s += r[i]! - m; if (i >= q) s -= r[i - q]! - m; if (i >= q - 1) sums.push(s); }
    const v = sums.reduce((a, x) => a + x * x, 0) / sums.length;
    if (v > 0) { xs.push(Math.log(q)); ys.push(Math.log(v)); }
  }
  if (xs.length < 3) return 0.5;
  const mx = mean(xs), my = mean(ys);
  const slope = xs.reduce((a, x, i) => a + (x - mx) * (ys[i]! - my), 0) / xs.reduce((a, x) => a + (x - mx) ** 2, 0);
  return slope / 2;
}

export function autocorr(r: number[], lag = 1): number {
  const m = mean(r), v = r.reduce((a, x) => a + (x - m) ** 2, 0);
  if (v <= 0) return 0;
  let c = 0;
  for (let i = lag; i < r.length; i++) c += (r[i]! - m) * (r[i - lag]! - m);
  return c / v;
}

/** Demi-vie (en bougies) du retour vers la moyenne mobile : Δécart = β·écart + bruit ⇒ demi-vie = −ln 2 / ln(1 + β). */
export function halfLife(c: Candle[], window = 50): number | null {
  const lp = c.map((x) => Math.log(x.c));
  const dev: number[] = [];
  let s = 0;
  for (let i = 0; i < lp.length; i++) { s += lp[i]!; if (i >= window) s -= lp[i - window]!; dev.push(i >= window - 1 ? lp[i]! - s / window : NaN); }
  const x: number[] = [], y: number[] = [];
  for (let i = window; i < dev.length; i++) { x.push(dev[i - 1]!); y.push(dev[i]! - dev[i - 1]!); }
  if (x.length < 50) return null;
  const mx = mean(x), my = mean(y);
  const beta = x.reduce((a, v, i) => a + (v - mx) * (y[i]! - my), 0) / x.reduce((a, v) => a + (v - mx) ** 2, 0);
  if (!(beta < 0) || beta <= -1) return null;
  return -Math.LN2 / Math.log(1 + beta);
}

/** Analyse statistique d'un marché (à appeler sur la seule partie entraînement). */
export function analyze(c: Candle[]): MathInsight {
  const r = logReturns(c);
  const vr = SPACE.tendance.breakout.map((q) => ({ q, ...varianceRatio(r, q) })).map((x) => ({ q: x.q, vr: r3(x.vr), z: r3(x.z) }));
  const h = hurst(r), ac1 = autocorr(r), hl = halfLife(c);
  const best = [...vr].sort((a, b) => Math.abs(b.z) - Math.abs(a.z))[0]!;
  const significant = Math.abs(best.z) > 1.96;
  let regime: Regime = "hasard";
  if ((significant && best.z > 0) || h > 0.55) regime = "tendance";
  else if ((significant && best.z < 0) || h < 0.45) regime = "retour à la moyenne";
  const note = regime === "tendance"
    ? `les mouvements se prolongent (Hurst ${h.toFixed(2)}, VR(${best.q}) = ${best.vr.toFixed(2)}, z = ${best.z.toFixed(1)})`
    : regime === "retour à la moyenne"
      ? `les écarts se corrigent (Hurst ${h.toFixed(2)}, VR(${best.q}) = ${best.vr.toFixed(2)}, z = ${best.z.toFixed(1)}${hl ? `, demi-vie ${hl.toFixed(0)} bougies` : ""})`
      : `aucun effet statistiquement significatif (Hurst ${h.toFixed(2)}, |z| max ${Math.abs(best.z).toFixed(1)} < 1,96) : proche d'une marche au hasard`;
  return { regime, hurst: r3(h), ac1: r3(ac1), halfLife: hl ? r3(hl) : null, vr, bestQ: best.q, significant, bars: c.length, note };
}

/** Réglages de tendance déduits des données : stop suiveur = repli « normal » dans une tendance, force minimale = force typique des cassures. */
function trendParams(c: Candle[], q: number, tight = false, fast = false): Params {
  const a = atr(c, STRATEGY.atrPeriod), closes = c.map((x) => x.c);
  const ef = ema(closes, STRATEGY.emaFast), es = ema(closes, STRATEGY.emaSlow);
  const pullbacks: number[] = [], strengths: number[] = [];
  for (let i = Math.max(q, STRATEGY.emaSlow); i < c.length - q; i++) {
    let hi = -Infinity; for (let j = i - q; j < i; j++) hi = Math.max(hi, c[j]!.h);
    if (closes[i]! <= hi || !(a[i]! > 0)) continue; // cassure haussière
    strengths.push(Math.abs(ef[i]! - es[i]!) / a[i]!);
    let run = c[i]!.h, worst = 0;
    for (let j = i + 1; j <= i + q; j++) { run = Math.max(run, c[j]!.h); worst = Math.max(worst, (run - c[j]!.l) / a[i]!); }
    pullbacks.push(worst);
  }
  return {
    breakout: q,
    // agressif : stop au repli médian (plus serré) et force minimale plus basse ⇒ plus de trades, plus de faux signaux
    trailAtr: snap(Number.isFinite(quantile(pullbacks, tight ? 0.5 : 0.7)) ? quantile(pullbacks, tight ? 0.5 : 0.7) : 3, space(fast).tendance.trailAtr),
    minTrend: snap(Number.isFinite(quantile(strengths, tight ? 0.25 : 0.4)) ? quantile(strengths, tight ? 0.25 : 0.4) : 1, space(fast).tendance.minTrend),
  };
}

/** Réglages RSI déduits des données : période ≈ demi-vie, seuils = niveaux de RSI réellement rares sur ce marché. */
function rsiParams(c: Candle[], hl: number | null, o: ProposeOptions = {}): RsiParams {
  const S = space(o.fast);
  const rsiPeriod = snap(hl ?? 14, S.rsi.rsiPeriod);
  const rs = rsiSeries(c.map((x) => x.c), rsiPeriod);
  const entry = snap(quantile(rs, o.aggressive ? 0.12 : 0.07), S.rsi.entry); // agressif : excès moins rares ⇒ plus de signaux
  const exits = SPACE.rsi.exit.filter((x) => x > entry + 10);
  return { rsiPeriod, entry, exit: snap(quantile(rs, 0.55), exits.length ? exits : [entry + 20]), smaPeriod: snap((hl ?? 20) * 8, SPACE.rsi.smaPeriod), swingBars: snap(hl ?? 10, SPACE.rsi.swingBars), riskPct: 1, naive: false };
}

/** Propositions du mathématicien pour un marché (3 à 4 stratégies, avec leur justification). */
export interface ProposeOptions { aggressive?: boolean; fast?: boolean }
export function propose(trainCandles: Candle[], m: Market, ins = analyze(trainCandles), o: ProposeOptions = {}): Proposal[] {
  const base = { market: m.name, product: m.product, symbol: m.symbol, kind: m.kind, interval: m.interval };
  const out: Proposal[] = [];
  const grid = SPACE.tendance.breakout;
  const trendQs = ins.regime === "tendance"
    ? [...ins.vr].filter((x) => x.z > 0).sort((a, b) => b.z - a.z).slice(0, 2).map((x) => x.q)
    : ins.regime === "hasard" ? [grid[grid.length - 1]!] : []; // au hasard : seulement des cassures lentes, plus robustes aux faux signaux
  for (const q of trendQs.length ? trendQs : ins.regime === "tendance" ? [ins.bestQ] : []) {
    const p = trendParams(trainCandles, q);
    out.push({ candidate: { ...base, family: "tendance", params: p },
      rationale: `${ins.note} ⇒ suivre la tendance sur ${q} bougies (horizon où l'effet est le plus fort) ; stop ${p.trailAtr} ATR = 70 % des replis observés pendant les tendances ; force ≥ ${p.minTrend} ATR = force typique des vraies cassures` });
  }
  // TENDANCE : achat sur repli, en plus de la cassure (plus d'entrées, meilleur prix)
  if (ins.regime === "tendance" && out[0]?.candidate.family === "tendance") {
    const p0 = out[0].candidate.params as Params;
    out.push({ candidate: { ...base, family: "tendance", params: { ...p0, entry: "repli" } },
      rationale: `même tendance mesurée, mais entrée sur repli vers la moyenne 20 au lieu d'attendre une cassure : plus d'entrées, à un meilleur prix` });
  }
  // NERVEUX : horizon court parmi les cassures rapides, si les rendements s'y prolongent encore (VR > 1)
  if (o.fast && ins.regime !== "retour à la moyenne") {
    const r = logReturns(trainCandles);
    const fastQ = [6, 8, 12].map((q) => ({ q, ...varianceRatio(r, q) })).sort((a, b) => b.z - a.z)[0]!;
    if (fastQ.vr > 1 && !out.some((x) => (x.candidate.params as Params).breakout === fastQ.q)) {
      const p = trendParams(trainCandles, fastQ.q, o.aggressive, true);
      out.push({ candidate: { ...base, family: "tendance", params: p },
        rationale: `version nerveuse : cassure courte de ${fastQ.q} bougies (VR(${fastQ.q}) = ${fastQ.vr.toFixed(2)}, z = ${fastQ.z.toFixed(1)}) ⇒ beaucoup plus de trades ; stop ${p.trailAtr} ATR` });
    }
  }
  // AGRESSIF : variante plus serrée de la meilleure idée de tendance, même quand le marché ressemble au hasard
  if (o.aggressive && out[0]?.candidate.family === "tendance") {
    const q = (out[0].candidate.params as Params).breakout;
    const p = trendParams(trainCandles, q, true, o.fast);
    if (p.trailAtr !== (out[0].candidate.params as Params).trailAtr || p.minTrend !== (out[0].candidate.params as Params).minTrend)
      out.push({ candidate: { ...base, family: "tendance", params: p }, rationale: `variante agressive : stop au repli médian (${p.trailAtr} ATR) et force ≥ ${p.minTrend} ATR, plus de trades mais plus de faux départs` });
  }
  // PERPS en marché qui revient à la moyenne : range (bandes de Bollinger) réglé sur la demi-vie mesurée
  if (m.kind === "perps" && ins.regime !== "tendance") {
    const S = space(o.fast).range;
    const p = { bbPeriod: snap((ins.halfLife ?? 10) * 2, S.bbPeriod), bbK: 2, stopAtr: 1.5, maxTrend: ins.regime === "retour à la moyenne" ? 1.5 : 1 };
    out.push({ candidate: { ...base, family: "range", params: p },
      rationale: `${ins.note} ⇒ trader le range : vendre au-dessus de la bande haute, acheter sous la bande basse, objectif le retour à la moyenne ; période ${p.bbPeriod} ≈ 2 × la demi-vie${ins.halfLife ? ` (${ins.halfLife.toFixed(0)} bougies)` : ""}` });
    if (o.aggressive) out.push({ candidate: { ...base, family: "range", params: { ...p, bbK: 1.5 } }, rationale: "variante agressive : bandes plus étroites (1,5 écart-type), plus de signaux" });
  }
  if (m.kind === "spot" && (ins.regime !== "tendance" || o.aggressive)) {
    const p = rsiParams(trainCandles, ins.halfLife, o);
    out.push({ candidate: { ...base, family: "rsi", params: p },
      rationale: `${ins.note} ⇒ acheter les excès de baisse : RSI(${p.rsiPeriod}) ≈ demi-vie, entrée sous ${p.entry} (atteint seulement ~${o.aggressive ? 12 : 7} % du temps sur ce marché), sortie au-dessus de ${p.exit}${ins.regime === "tendance" ? " (proposée en mode agressif malgré la tendance)" : ""}` });
    const p2 = { ...p, entry: snap(p.entry - 5, SPACE.rsi.entry) };
    if (p2.entry !== p.entry) out.push({ candidate: { ...base, family: "rsi", params: p2 }, rationale: `variante plus sélective de la précédente (entrée sous ${p2.entry}) : moins de trades, chaque signal plus extrême` });
  }
  return out;
}

// ------------------------------------------------------------------------------------------------
// CHANCE OU TALENT ?
// Quand on teste des milliers de stratégies, certaines gagnent par pur hasard. Le mathématicien estime la
// probabilité qu'une stratégie ait obtenu son résultat (sur la période jamais vue) juste par chance, en tenant
// compte du nombre de stratégies déjà essayées sur ce marché (correction des tests multiples).
// ------------------------------------------------------------------------------------------------
/** Fonction de répartition de la loi normale (approximation d'Abramowitz-Stegun, précision 1e-7). */
export function normCdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp((-x * x) / 2);
  const p = d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x >= 0 ? 1 - p : p;
}
/**
 * Probabilité que le résultat soit de la chance.
 * t = gain moyen par trade / (écart-type / √trades) : la force du résultat.
 * Avec M essais indépendants, la meilleure stratégie au hasard dépasse t avec la probabilité 1 − Φ(t)^M.
 * Les stratégies d'un même marché se ressemblent beaucoup : on compte ~1 essai indépendant pour 20 testés.
 */
export const LUCK = { correlated: 20, reject: 0.5, rejectAggressive: 0.8 };
export function luckProbability(s: { trades: number; meanPct?: number; sdPct?: number }, tested: number): number | null {
  if (s.meanPct == null || s.sdPct == null || s.trades < 2) return null;
  if (s.meanPct <= 0) return 1;
  const t = s.sdPct > 0 ? s.meanPct / (s.sdPct / Math.sqrt(s.trades)) : 10;
  const m = Math.max(1, tested / LUCK.correlated);
  return Math.round((1 - Math.pow(normCdf(t), m)) * 1000) / 1000;
}
