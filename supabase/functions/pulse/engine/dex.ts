// Serveur uniquement : données on-chain des tokens Solana (DexScreener, API publique gratuite, sans clé).
// Liquidité, volume, âge des paires : utilisées pour la sortie d'urgence (liquidité qui s'effondre) et le sélectionneur.
const DS = "https://api.dexscreener.com";

export interface DexPair {
  dexId: string; pairAddress: string; baseToken: { address: string; symbol: string; name?: string }; quoteToken: { address: string; symbol: string };
  priceUsd?: string; liquidity?: { usd?: number }; volume?: { h24?: number; h1?: number }; pairCreatedAt?: number; fdv?: number; marketCap?: number;
  txns?: { h24?: { buys?: number; sells?: number } }; priceChange?: { h1?: number; h24?: number };
}

/** Toutes les paires où apparaissent ces tokens (30 adresses maximum par appel). */
export async function dexPairs(mints: string[]): Promise<DexPair[]> {
  const out: DexPair[] = [];
  for (let i = 0; i < mints.length; i += 30) {
    const res = await fetch(`${DS}/tokens/v1/solana/${mints.slice(i, i + 30).join(",")}`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`DexScreener indisponible (${res.status})`);
    const rows = (await res.json()) as DexPair[];
    if (Array.isArray(rows)) out.push(...rows);
  }
  return out;
}

/** Liquidité totale (USD) de chaque token, toutes paires confondues. */
export async function tokenLiquidity(mints: string[]): Promise<Record<string, number>> {
  const pairs = await dexPairs(mints);
  const liq: Record<string, number> = {};
  for (const p of pairs) {
    const usd = p.liquidity?.usd ?? 0;
    for (const m of mints) if (p.baseToken?.address === m || p.quoteToken?.address === m) liq[m] = (liq[m] ?? 0) + usd;
  }
  return liq;
}
