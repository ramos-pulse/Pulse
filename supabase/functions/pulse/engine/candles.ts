// Serveur uniquement : bougies depuis l'API publique Coinbase (gratuite, sans clé).
// Format Coinbase : [time(s), low, high, open, close, volume], du plus récent au plus ancien, 300 bougies max par appel.
import { INTERVAL_MS, type Candle, type Interval } from "./strategy.ts";

const BASE = "https://api.exchange.coinbase.com/products";

async function page(product: string, granSec: number, startMs: number, endMs: number): Promise<Candle[]> {
  const url = `${BASE}/${product}/candles?granularity=${granSec}&start=${new Date(startMs).toISOString()}&end=${new Date(endMs).toISOString()}`;
  const res = await fetch(url, { headers: { "user-agent": "pulse-autopilot" }, signal: AbortSignal.timeout(12_000) });
  if (!res.ok) throw new Error(`Bougies ${product} indisponibles (${res.status})`);
  const rows = (await res.json()) as number[][];
  return rows.map(([t, l, h, o, c, v]) => ({ t: t! * 1000, o: o!, h: h!, l: l!, c: c!, v: v ?? 0 }));
}

/** Bougies CLÔTURÉES uniquement, de la plus ancienne à la plus récente. */
export async function candles(product: string, interval: Interval, count: number, now = Date.now()): Promise<Candle[]> {
  const step = INTERVAL_MS[interval];
  const end = Math.floor(now / step) * step; // début de la bougie en cours = fin de la dernière bougie clôturée
  const all = new Map<number, Candle>();
  for (let to = end; to > end - count * step; to -= 300 * step) {
    const from = Math.max(end - count * step, to - 300 * step);
    for (const c of await page(product, step / 1000, from, to)) all.set(c.t, c);
  }
  return [...all.values()].filter((c) => c.t + step <= end).sort((a, b) => a.t - b.t);
}

export const hourlyCandles = (product: string, hours: number, now = Date.now()) => candles(product, "1h", hours, now);

/** Début de la dernière bougie clôturée : sert à n'analyser chaque bougie qu'une seule fois. */
export const lastClosedCandle = (now = Date.now(), interval: Interval = "1h") => {
  const step = INTERVAL_MS[interval];
  return Math.floor(now / step) * step - step;
};
