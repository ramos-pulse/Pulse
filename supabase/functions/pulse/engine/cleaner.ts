// L'AGENT SWAP : nettoie les portefeuilles des bots, comme le bouton « Reclaim » de Jupiter, mais tout seul.
//  1. Revend en USDC les restes de tokens qui valent au moins 0,50 $ (jamais USDC, jamais la position en cours du bot).
//  2. Ferme les comptes de tokens VIDES : chaque compte fermé rend ~0,002 SOL de caution au portefeuille.
//  Il ne détruit jamais de tokens : un reste qui vaut moins de 0,50 $ est laissé tel quel.
import { executeSwap, getQuote } from "./jupiter.ts";
import { closeTokenAccounts, listTokenAccounts, loadKeyPairFrom, waitForTx, WSOL_MINT, type TokenAccount } from "./solana.ts";
import { TOKENS, USDC_MINT } from "./strategy.ts";

export const CLEANER = { minSellUsd: 0.5, maxImpactPct: 5, slippageBps: 300, batch: 8, maxSales: 3, maxCloseTx: 3 };

export interface CleanReport {
  wallet: string;
  sold: { mint: string; symbol: string; usd: number; sig: string }[];
  closed: number;
  solRecovered: number;
  closeSigs: string[];
  skipped: string[];
  errors: string[];
}

const symbolOf = (mint: string) => TOKENS.find((t) => t.mint === mint)?.symbol ?? `${mint.slice(0, 4)}…`;

/**
 * @param keepMints  tokens à ne jamais toucher (USDC, position en cours, transaction en attente)
 * @param sellUniverse  false pour le bot spot : les tokens de son univers sont gérés par lui, pas par l'agent
 */
export async function cleanWallet(o: { envKey: string; keepMints: Set<string>; sellUniverse: boolean }): Promise<CleanReport> {
  const { address, keyPair } = await loadKeyPairFrom(o.envKey);
  const r: CleanReport = { wallet: address, sold: [], closed: 0, solRecovered: 0, closeSigs: [], skipped: [], errors: [] };
  const universe = new Set<string>(TOKENS.map((t) => t.mint));
  const keep = new Set([...o.keepMints, USDC_MINT]);

  // 1. Revendre les restes
  for (const a of await listTokenAccounts(address)) {
    if (a.amount === 0n || a.mint === WSOL_MINT || keep.has(a.mint)) continue;
    if (r.sold.length >= CLEANER.maxSales) { r.skipped.push(`${symbolOf(a.mint)} : au prochain passage`); continue; }
    if (!o.sellUniverse && universe.has(a.mint)) { r.skipped.push(`${symbolOf(a.mint)} : géré par le bot`); continue; }
    try {
      const q = await getQuote(a.mint, USDC_MINT, a.amount, CLEANER.slippageBps);
      const usd = Number(q.outAmount) / 1e6, impact = Number(q.priceImpactPct) * 100;
      if (usd < CLEANER.minSellUsd) { r.skipped.push(`${symbolOf(a.mint)} : ${usd.toFixed(2)} $, trop peu pour valoir les frais`); continue; }
      if (impact > CLEANER.maxImpactPct) { r.skipped.push(`${symbolOf(a.mint)} : pas assez de liquidité (impact ${impact.toFixed(1)} %)`); continue; }
      const sig = await executeSwap(q, address, keyPair);
      const st = await waitForTx(sig, 25_000);
      if (st === "confirmed") r.sold.push({ mint: a.mint, symbol: symbolOf(a.mint), usd, sig });
      else r.errors.push(`${symbolOf(a.mint)} : vente ${st}`);
    } catch (e) {
      r.skipped.push(`${symbolOf(a.mint)} : invendable (${(e as Error).message.slice(0, 60)})`);
    }
  }

  // 2. Fermer les comptes vides (et le SOL emballé, qui redevient du SOL normal)
  const closable: TokenAccount[] = (await listTokenAccounts(address))
    .filter((a) => !keep.has(a.mint) && (a.amount === 0n || a.mint === WSOL_MINT));
  for (let i = 0; i < Math.min(closable.length, CLEANER.batch * CLEANER.maxCloseTx); i += CLEANER.batch) {
    const batch = closable.slice(i, i + CLEANER.batch);
    try {
      const sig = await closeTokenAccounts(keyPair, address, batch);
      const st = await waitForTx(sig, 25_000);
      if (st !== "confirmed") { r.errors.push(`fermeture de ${batch.length} comptes : ${st}`); continue; }
      r.closed += batch.length;
      r.solRecovered += batch.reduce((s, a) => s + a.lamports, 0) / 1e9;
      r.closeSigs.push(sig);
    } catch (e) {
      r.errors.push(`fermeture : ${(e as Error).message.slice(0, 80)}`);
    }
  }
  return r;
}
