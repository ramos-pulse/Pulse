// Serveur uniquement : bougies (historique des prix).
//  - Coinbase (gratuit, sans clé) pour les grands tokens : produit « SOL-USD »…
//  - n'importe quel token Solana, à partir de son historique ON-CHAIN :
//      « gt:<adresse du pool> »  → GeckoTerminal (gratuit, sans clé)
//      « hl:<marché> »           → Hyperliquid (perps, gratuit, sans clé)
//      « be:<adresse du token> » → Birdeye (clé BIRDEYE_API_KEY), plus rapide et plus complet ; si la clé manque ou si
//                                  Birdeye échoue, on repasse par GeckoTerminal (pool fourni après « | »).
// Format Coinbase : [time(s), low, high, open, close, volume], du plus récent au plus ancien, 300 bougies max par appel.
import { INTERVAL_MS, type Candle, type Interval } from "./strategy.ts";
import { env } from "./solana.ts";
import { hlCandles } from "./hyperliquid.ts";

const BASE = "https://api.exchange.coinbase.com/products";

async function page(product: string, granSec: number, startMs: number, endMs: number): Promise<Candle[]> {
  const url = `${BASE}/${product}/candles?granularity=${granSec}&start=${new Date(startMs).toISOString()}&end=${new Date(endMs).toISOString()}`;
  const res = await fetch(url, { headers: { "user-agent": "pulse-autopilot" }, signal: AbortSignal.timeout(12_000) });
  if (!res.ok) throw new Error(`Bougies ${product} indisponibles (${res.status})`);
  const rows = (await res.json()) as number[][];
  return rows.map(([t, l, h, o, c, v]) => ({ t: t! * 1000, o: o!, h: h!, l: l!, c: c!, v: v ?? 0 }));
}

/** GeckoTerminal : 1000 bougies maximum par appel, de la plus récente à la plus ancienne. */
async function gecko(pool: string, interval: Interval, count: number, end: number): Promise<Candle[]> {
  const step = INTERVAL_MS[interval], tf = interval === "1h" ? "hour?aggregate=1" : "minute?aggregate=15";
  const all = new Map<number, Candle>();
  let before = end / 1000;
  for (let k = 0; k < 8 && all.size < count; k++) {
    const url = `https://api.geckoterminal.com/api/v2/networks/solana/pools/${pool}/ohlcv/${tf}&limit=1000&currency=usd&before_timestamp=${Math.floor(before)}`;
    const res = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(12_000) });
    if (!res.ok) throw new Error(`Historique GeckoTerminal indisponible (${res.status})`);
    const rows = ((await res.json()) as { data?: { attributes?: { ohlcv_list?: number[][] } } }).data?.attributes?.ohlcv_list ?? [];
    if (!rows.length) break;
    for (const [t, o, h, l, c, v] of rows) all.set(t! * 1000, { t: t! * 1000, o: o!, h: h!, l: l!, c: c!, v: v ?? 0 });
    before = Math.min(...rows.map((r) => r[0]!));
  }
  return [...all.values()].filter((c) => c.t + step <= end && c.t >= end - count * step).sort((a, b) => a.t - b.t);
}

/** Birdeye : nécessite la clé BIRDEYE_API_KEY. */
async function birdeye(mint: string, interval: Interval, count: number, end: number): Promise<Candle[]> {
  const key = env("BIRDEYE_API_KEY");
  if (!key) throw new Error("clé Birdeye absente");
  const step = INTERVAL_MS[interval], all = new Map<number, Candle>();
  for (let to = end; to > end - count * step; to -= 1000 * step) {
    const from = Math.max(end - count * step, to - 1000 * step);
    const url = `https://public-api.birdeye.so/defi/ohlcv?address=${mint}&type=${interval === "1h" ? "1H" : "15m"}&time_from=${Math.floor(from / 1000)}&time_to=${Math.floor(to / 1000)}`;
    const res = await fetch(url, { headers: { "X-API-KEY": key, "x-chain": "solana", accept: "application/json" }, signal: AbortSignal.timeout(12_000) });
    if (!res.ok) throw new Error(`Historique Birdeye indisponible (${res.status})`);
    const items = ((await res.json()) as { data?: { items?: { unixTime: number; o: number; h: number; l: number; c: number; v: number }[] } }).data?.items ?? [];
    for (const x of items) all.set(x.unixTime * 1000, { t: x.unixTime * 1000, o: x.o, h: x.h, l: x.l, c: x.c, v: x.v });
  }
  return [...all.values()].filter((c) => c.t + step <= end).sort((a, b) => a.t - b.t);
}

/** Bougies CLÔTURÉES uniquement, de la plus ancienne à la plus récente. */
export async function candles(product: string, interval: Interval, count: number, now = Date.now()): Promise<Candle[]> {
  const step = INTERVAL_MS[interval];
  const end = Math.floor(now / step) * step; // début de la bougie en cours = fin de la dernière bougie clôturée
  if (product.startsWith("gt:")) return gecko(product.slice(3), interval, count, end);
  if (product.startsWith("hl:")) return hlCandles(product.slice(3), interval, count, end); // perps Hyperliquid (gratuit, sans clé)
  if (product.startsWith("be:")) {
    const [mint, pool] = product.slice(3).split("|");
    try { return await birdeye(mint!, interval, count, end); }
    catch (e) { if (pool) return gecko(pool, interval, count, end); throw e; }
  }
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
