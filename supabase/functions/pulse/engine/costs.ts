// FRAIS RÉELS DU SPOT (28/11) : au lieu d'un coût fixe de 0,3-0,4 % par côté, le chercheur juge les stratégies spot
// avec le coût MESURÉ de chaque token : une cotation Jupiter aller-retour (achat puis revente aussitôt) donne frais des pools,
// écart et impact de prix ; on y ajoute les frais de transaction Solana (pourboire Jito compris) rapportés à une petite mise.
// Prudence : la perte mesurée est comptée ×1,5, avec un plancher. Mesure renouvelée chaque jour, quelques tokens par cycle.

export const COSTS = {
  quoteUsd: 20,          // cotation à 20 $ (plus que la mise réelle : impact de prix légèrement surestimé)
  tradeUsd: 5,           // frais de transaction rapportés à une mise de 5 $ (petite mise : poids des frais surestimé)
  txLamports: 50_000,    // par swap : 5 000 de base + pourboire Jito 20 000, avec de la marge si l'envoi privé échoue
  margin: 1.5,           // perte de l'aller-retour comptée ×1,5
  floor: 0.001,          // jamais moins de 0,1 % par côté
  maxAgeMs: 24 * 3_600_000,
  perCycle: 3,
  pauseMs: 1100,         // pause entre deux cotations (limite de débit de Jupiter)
  defaultFixed: 0.003,   // avant la première mesure : l'ancien coût (tokens de la liste fixe)
  defaultSelected: 0.004,
};

export interface SpotCost { side: number; roundTrip: number; tx: number; at: number }
export type SpotCosts = Record<string, SpotCost>;

let CURRENT: SpotCosts = {};
export const setSpotCosts = (c: SpotCosts) => { CURRENT = c ?? {}; };
export const spotCosts = () => CURRENT;

/** Coût par côté utilisé par le chercheur pour un token (mesuré s'il est frais de moins de 3 jours, sinon l'ancien coût fixe). */
export function spotFee(symbol: string, fallback: number, now = Date.now()): number {
  const c = CURRENT[symbol.toUpperCase()];
  return c && now - c.at < 3 * COSTS.maxAgeMs && c.side > 0 ? c.side : fallback;
}

/** Coût par côté à partir d'un aller-retour coté : USDC engagés, USDC récupérés, prix du SOL. */
export function costFromRoundTrip(usdIn: number, usdBack: number, solUsd: number): SpotCost | null {
  if (!(usdIn > 0) || !(usdBack > 0) || !(solUsd > 0) || usdBack > usdIn * 1.01) return null; // cotation absurde : ignorée
  const roundTrip = Math.max(0, 1 - usdBack / usdIn);
  const tx = (COSTS.txLamports / 1e9) * solUsd / COSTS.tradeUsd;
  const side = Math.max(COSTS.floor, (roundTrip / 2) * COSTS.margin + tx);
  return { side: Math.round(side * 1e6) / 1e6, roundTrip: Math.round(roundTrip * 1e6) / 1e6, tx: Math.round(tx * 1e6) / 1e6, at: 0 };
}

/** Tokens à mesurer ce cycle : jamais mesurés d'abord, puis les plus anciens (au plus perCycle). */
export function dueForMeasure(symbols: string[], costs: SpotCosts, now = Date.now()): string[] {
  return [...new Set(symbols.map((s) => s.toUpperCase()))]
    .filter((s) => !costs[s] || now - costs[s]!.at > COSTS.maxAgeMs)
    .sort((a, b) => (costs[a]?.at ?? 0) - (costs[b]?.at ?? 0))
    .slice(0, COSTS.perCycle);
}

/** Le coût a-t-il assez changé pour que les stratégies déjà rejetées de ce token méritent d'être re-testées ? */
export const costChanged = (before: SpotCost | undefined, fallback: number, after: SpotCost) =>
  Math.abs((before?.side ?? fallback) - after.side) / Math.max(before?.side ?? fallback, 1e-6) > 0.3;
