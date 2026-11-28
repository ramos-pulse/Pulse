// Le « cerveau » du bot : sa volonté de réussir, sous forme de discipline mesurable (logique pure, testable).
//
// Ce que veut dire « vouloir réussir » pour un bot de trading :
//  1. NE JAMAIS ABANDONNER  : il se relance, réessaie, réconcilie son état avec la blockchain, ne s'arrête pas sur une panne.
//  2. SURVIVRE D'ABORD      : on ne peut pas atteindre l'objectif si le compte est mort. Jamais de martingale, jamais de
//                             « tout ou rien » pour rattraper une perte : c'est la cause n°1 de faillite des comptes.
//  3. APPRENDRE              : il note chaque trade, met sur le banc un marché qui ne lui réussit pas.
//  4. S'ADAPTER              : chaque jour il rejoue les 60 derniers jours avec 3 réglages et garde celui qui marche
//                             le mieux ; si aucun ne marche, il attend au lieu de forcer.
//  5. APPUYER QUAND ÇA MARCHE: risque augmenté (dans une limite stricte) quand il est en forme, réduit quand il perd.
import { backtest, PRESETS, RISK, type BacktestResult, type Candle } from "./strategy.ts";

export const BRAIN = {
  minMult: 1 / 3,          // risque mini : 0,5 % par trade
  maxMult: 4 / 3,          // risque maxi : 2 % par trade (plafond absolu, jamais dépassé)
  lossFactor: 0.75,        // après une perte, risque × 0,75
  winStep: 0.15,           // après un gain, le risque remonte progressivement
  benchAfterTrades: 8,     // un marché avec ≥ 8 trades récents…
  benchBelowPF: 0.8,       // …et un profit factor < 0,8 est mis sur le banc…
  benchMs: 48 * 3_600_000, // …pendant 48 h
  memory: 40,              // nombre de trades retenus pour juger sa forme
};

export interface TradeMemo { asset: string; pnlPct: number; t: number }
export interface Brain {
  riskMult: number;
  streak: number;                       // > 0 : gains d'affilée, < 0 : pertes d'affilée
  equityHigh: number;
  trades: TradeMemo[];
  benched: Record<string, number>;      // marché → fin de mise sur le banc (ms)
  preset: Record<string, string>;       // marché → réglage choisi
  disabled: Record<string, string>;     // marché → raison (aucun réglage rentable récemment)
  optimized: Record<string, string>;    // marché → jour de la dernière optimisation
  report?: Record<string, { preset: string; pf: number; ret: number; dd: number; trades: number }>;
}

export const newBrain = (equity = 0): Brain => ({
  riskMult: 1, streak: 0, equityHigh: equity, trades: [], benched: {}, preset: {}, disabled: {}, optimized: {},
});

export function pf(list: TradeMemo[]): number {
  const w = list.filter((t) => t.pnlPct > 0).reduce((s, t) => s + t.pnlPct, 0);
  const l = -list.filter((t) => t.pnlPct <= 0).reduce((s, t) => s + t.pnlPct, 0);
  return l > 0 ? w / l : w > 0 ? Infinity : 0;
}

/** Risque par trade (fraction du capital) selon la forme du moment. Toujours entre 0,5 % et 2 %. */
export function riskPerTrade(b: Brain): number {
  const m = Math.min(BRAIN.maxMult, Math.max(BRAIN.minMult, b.riskMult));
  return RISK.perTrade * m;
}

/** À appeler après chaque trade clôturé (PnL réel, frais inclus). */
export function learn(b: Brain, asset: string, pnlPct: number, equity: number, now: number, neutral = false): void {
  b.trades = [...b.trades, { asset, pnlPct, t: now }].slice(-BRAIN.memory);
  // 28/11 : sortie à l'équilibre par un stop déjà remonté à l'entrée (frais seulement) : ni victoire ni défaite pour la forme du bot
  if (neutral && pnlPct <= 0) { b.equityHigh = Math.max(b.equityHigh, equity); return; }
  if (pnlPct > 0) {
    b.streak = b.streak > 0 ? b.streak + 1 : 1;
    b.riskMult = Math.min(1, b.riskMult + BRAIN.winStep);
    // Plus haut historique ET bonne forme récente : il appuie un peu (jamais au-delà de 2 %).
    const recent = b.trades.slice(-20);
    if (equity > b.equityHigh && recent.length >= 10 && pf(recent) > 1.3) b.riskMult = Math.min(BRAIN.maxMult, b.riskMult + 0.1);
  } else {
    b.streak = b.streak < 0 ? b.streak - 1 : -1;
    b.riskMult = Math.max(BRAIN.minMult, b.riskMult * BRAIN.lossFactor);
  }
  b.equityHigh = Math.max(b.equityHigh, equity);
  const mine = b.trades.filter((t) => t.asset === asset);
  if (mine.length >= BRAIN.benchAfterTrades && pf(mine.slice(-BRAIN.benchAfterTrades)) < BRAIN.benchBelowPF) {
    b.benched[asset] = now + BRAIN.benchMs;
  }
}

export function isBenched(b: Brain, asset: string, now: number): boolean {
  return (b.benched[asset] ?? 0) > now || asset in b.disabled;
}

/** Choisit le meilleur réglage sur les 60 derniers jours. Critère robuste : rendement / drawdown, avec garde-fous. */
export function choosePreset(results: Record<string, BacktestResult>): { name: string | null; reason: string } {
  let best: { name: string; score: number } | null = null;
  for (const [name, r] of Object.entries(results)) {
    if (r.trades < 4 || r.profitFactor < 1.1 || r.maxDrawdownPct > 30) continue;
    const score = r.returnPct / Math.max(r.maxDrawdownPct, 5);
    if (!best || score > best.score) best = { name, score };
  }
  return best ? { name: best.name, reason: "meilleur rendement/risque sur 60 jours" } : { name: null, reason: "aucun réglage rentable sur 60 jours : j'attends un meilleur marché" };
}

/** Optimisation quotidienne d'un marché (appelée une fois par jour avec ~60 jours de bougies horaires). */
export function optimize(b: Brain, asset: string, candles: Candle[], o: { allowShort: boolean; feePct: number; hourlyCost?: number; leverageCap?: number }, day: string): void {
  b.optimized = { ...(b.optimized ?? {}), [asset]: day };
  const results: Record<string, BacktestResult> = {};
  for (const [name, params] of Object.entries(PRESETS)) results[name] = backtest(candles, { ...o, params });
  const pick = choosePreset(results);
  b.report = b.report ?? {};
  if (pick.name) {
    const r = results[pick.name]!;
    b.preset[asset] = pick.name;
    delete b.disabled[asset];
    b.report[asset] = { preset: pick.name, pf: round(r.profitFactor), ret: round(r.returnPct), dd: round(r.maxDrawdownPct), trades: r.trades };
  } else {
    b.disabled[asset] = pick.reason;
    b.report[asset] = { preset: "—", pf: 0, ret: 0, dd: 0, trades: 0 };
  }
}
const round = (n: number) => (Number.isFinite(n) ? Math.round(n * 100) / 100 : 99);

/** Message à la première personne affiché dans l'app : il explique ce qu'il fait et pourquoi. */
export function mindset(b: Brain, ctx: { inPosition: boolean; blocked: string | null; goalPct: number }): string {
  const risk = (riskPerTrade(b) * 100).toFixed(1).replace(".", ",");
  if (ctx.blocked) return `Je protège le capital : ${ctx.blocked}. Je reviens plus fort ensuite.`;
  if (b.streak <= -3) return `${-b.streak} pertes d'affilée. Je réduis mon risque à ${risk} % et je reste discipliné : une série perdante fait partie du jeu.`;
  if (b.streak >= 3) return `${b.streak} gains d'affilée. Je reste concentré, risque ${risk} % par trade.`;
  if (ctx.inPosition) return `En position. Je laisse courir le gain, mon stop suiveur protège le reste.`;
  return `Objectif rempli à ${ctx.goalPct.toFixed(1).replace(".", ",")} %. J'attends une vraie cassure en tendance, je ne force rien (risque ${risk} %).`;
}
