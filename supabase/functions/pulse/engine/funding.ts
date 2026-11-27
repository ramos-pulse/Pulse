// Serveur uniquement : taux de financement horaires des perps (API publique Hyperliquid, gratuite, sans clé).
// Jupiter Perps n'a pas de funding (seulement des frais d'emprunt) : Hyperliquid sert d'indicateur du positionnement
// de la foule sur SOL, ETH et BTC (funding très positif = la foule est massivement à l'achat).
const URL_HL = "https://api.hyperliquid.xyz/info";

export async function fundingHistory(coin: string, startMs: number, endMs = Date.now()): Promise<{ t: number; r: number }[]> {
  const out = new Map<number, number>();
  let from = startMs;
  for (let k = 0; k < 12 && from < endMs; k++) { // 500 points (≈ 20 jours) par appel
    const res = await fetch(URL_HL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "fundingHistory", coin, startTime: from, endTime: endMs }), signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`funding ${coin} indisponible (${res.status})`);
    const rows = (await res.json()) as { time: number; fundingRate: string }[];
    if (!rows.length) break;
    for (const r of rows) out.set(r.time, Number(r.fundingRate));
    const last = rows[rows.length - 1]!.time;
    if (last <= from) break;
    from = last + 1;
  }
  return [...out.entries()].sort((a, b) => a[0] - b[0]).map(([t, r]) => ({ t, r })).filter((x) => Number.isFinite(x.r));
}
