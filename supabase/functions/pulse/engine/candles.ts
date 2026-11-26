// Serveur uniquement : bougies horaires depuis l'API publique Coinbase (gratuite, sans clé).
// Format Coinbase : [time(s), low, high, open, close, volume], du plus récent au plus ancien, 300 bougies max par appel.
import type { Candle } from "./strategy.ts";

const HOUR = 3_600_000;
const BASE = "https://api.exchange.coinbase.com/products";

async function page(product: string, startMs: number, endMs: number): Promise<Candle[]> {
  const url = `${BASE}/${product}/candles?granularity=3600&start=${new Date(startMs).toISOString()}&end=${new Date(endMs).toISOString()}`;
  const res = await fetch(url, { headers: { "user-agent": "pulse-autopilot" }, signal: AbortSignal.timeout(12_000) });
  if (!res.ok) throw new Error(`Bougies ${product} indisponibles (${res.status})`);
  const rows = (await res.json()) as number[][];
  return rows.map(([t, l, h, o, c]) => ({ t: t! * 1000, o: o!, h: h!, l: l!, c: c! }));
}

/** Bougies horaires CLÔTURÉES uniquement, de la plus ancienne à la plus récente. */
export async function hourlyCandles(product: string, hours: number, now = Date.now()): Promise<Candle[]> {
  const end = Math.floor(now / HOUR) * HOUR; // début de l'heure en cours = fin de la dernière bougie clôturée
  const all = new Map<number, Candle>();
  for (let to = end; to > end - hours * HOUR; to -= 300 * HOUR) {
    const from = Math.max(end - hours * HOUR, to - 300 * HOUR);
    for (const c of await page(product, from, to)) all.set(c.t, c);
  }
  return [...all.values()].filter((c) => c.t + HOUR <= end).sort((a, b) => a.t - b.t);
}

/** Début de la dernière bougie clôturée : sert à n'analyser chaque bougie qu'une seule fois. */
export const lastClosedCandle = (now = Date.now()) => Math.floor(now / HOUR) * HOUR - HOUR;
