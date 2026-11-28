// Lecture du journal des trades (pur, testable).

/**
 * 28/11 : une vente partielle (bot 1, la moitié vendue à +1,5 R) appartient à la même position que la vente finale :
 * son résultat est ajouté à la fermeture qui suit (même stratégie, même token) au lieu de compter comme un trade à part.
 * Tant que la position n'est pas fermée, la vente partielle n'est pas comptée.
 */
export type TradeRow = { bot?: string; source?: string | null; symbol?: string | null; asset?: string | null; reason?: string | null; pnl_usd?: number | null; created_at: string };
export function mergePartials<T extends TradeRow>(rows: T[]): T[] {
  const sorted = [...rows].sort((a, b) => a.created_at.localeCompare(b.created_at)), pending = new Map<string, number>(), out: T[] = [];
  for (const t of sorted) {
    if (typeof t.pnl_usd !== "number") { out.push(t); continue; }
    const k = `${t.bot}|${t.source ?? ""}|${t.symbol ?? t.asset ?? ""}`;
    if (/partielle/.test(t.reason ?? "")) { pending.set(k, (pending.get(k) ?? 0) + t.pnl_usd); continue; }
    const extra = pending.get(k) ?? 0; pending.delete(k);
    out.push(extra ? { ...t, pnl_usd: Math.round((t.pnl_usd + extra) * 1e6) / 1e6 } : t);
  }
  return out;
}

