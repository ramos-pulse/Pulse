// NOUVELLES FAMILLES DE STRATÉGIES (logique pure, testable et backtestable).
//
//  - orb      : cassure de la zone d'ouverture (minuit UTC, Europe, Wall Street) ; objectif = multiple de la zone, stop de l'autre côté
//  - vwap     : retour au prix moyen de la journée (VWAP) quand le prix s'en écarte trop ; marché sans tendance forte
//  - squeeze  : cassure de compression : les bandes de Bollinger se resserrent fort, on suit l'explosion qui suit (stop suiveur)
//  - volume   : momentum de volume : volume anormal + bougie forte dans un sens (stop suiveur)
//  - funding  : funding extrême (perps) : quand la foule est massivement d'un côté, pari inverse si le prix confirme
//  - range    : (déjà existante) sortie des bandes de Bollinger, retour à la moyenne
//
// Deux types de gestion :
//  - « à objectif » (range, orb, vwap, funding) : stop fixe, sortie à l'objectif ou après un délai ;
//  - « suiveuses » (squeeze, volume) : gérées comme la tendance (stop suiveur chandelier, prise partielle, sortie si ça stagne).
import {
  activeHour, atr, barMsOf, bollinger, ema, PARTIAL, perpsChange, rangeExit, rangeSignal, RISK, sanitizeRange, STRATEGY, summarize, tfOf, trailStop, volScale,
  type BacktestResult, type Candle, type Params, type RangeParams, type Side, type Signal, type SimOpts,
} from "./strategy.ts";

export type SetupFamily = "range" | "orb" | "vwap" | "squeeze" | "volume" | "funding";
export const SETUP_FAMILIES: readonly SetupFamily[] = ["range", "orb", "vwap", "squeeze", "volume", "funding"];
export const isSetup = (f: unknown): f is SetupFamily => SETUP_FAMILIES.includes(f as SetupFamily);
/** Familles gérées avec un stop suiveur (comme la tendance). */
export const TRAILING: readonly SetupFamily[] = ["squeeze", "volume"];
/** Familles réservées aux perps (elles parient aussi à la baisse, ou utilisent des données perps). */
export const PERPS_ONLY: readonly SetupFamily[] = ["range", "funding"];

export type Session = "utc" | "eu" | "us";
export interface OrbParams { session: Session; zoneMin: number; target: number; window: number; hours?: "actives" }
export interface VwapParams { dev: number; stopAtr: number; maxTrend: number; hours?: "actives" }
export interface SqueezeParams { bbPeriod: number; bbK: number; lookback: number; pct: number; trailAtr: number; hours?: "actives" }
export interface VolumeParams { volMult: number; body: number; trailAtr: number; hours?: "actives" }
export interface FundingParams { level: number; stopAtr: number; hold: number }
export type SetupParams = RangeParams | OrbParams | VwapParams | SqueezeParams | VolumeParams | FundingParams;

/** Données externes : taux de financement horaires (Hyperliquid, indicateur du positionnement de la foule). */
export interface Extra { funding?: { t: number; r: number }[] }

/** Signal d'une stratégie « à objectif » : en plus du stop, un prix cible (facultatif). */
export interface SetupSignal extends Signal { target?: number }

const fmt = (n: number) => (n >= 1 ? n.toFixed(2) : n.toPrecision(3));
const num = (v: unknown, lo: number, hi: number) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : null; };
const hrs = (x: { hours?: unknown }) => (x.hours === "actives" ? { hours: "actives" as const } : {});

// ---------------------------------------------------------------------------------------------------
// Heures d'ouverture (heure d'été comprise)
// ---------------------------------------------------------------------------------------------------
const DAY = 86_400_000;
const nthSunday = (y: number, m: number, n: number) => { const wd = new Date(Date.UTC(y, m, 1)).getUTCDay(); return 1 + ((7 - wd) % 7) + (n - 1) * 7; };
const lastSunday = (y: number, m: number) => { const d = new Date(Date.UTC(y, m + 1, 0)); return d.getUTCDate() - d.getUTCDay(); };
/** Heure d'été américaine : du 2e dimanche de mars au 1er dimanche de novembre. */
export function usDst(t: number) { const y = new Date(t).getUTCFullYear(); return t >= Date.UTC(y, 2, nthSunday(y, 2, 2), 7) && t < Date.UTC(y, 10, nthSunday(y, 10, 1), 6); }
/** Heure d'été européenne : du dernier dimanche de mars au dernier dimanche d'octobre (1 h UTC). */
export function euDst(t: number) { const y = new Date(t).getUTCFullYear(); return t >= Date.UTC(y, 2, lastSunday(y, 2), 1) && t < Date.UTC(y, 9, lastSunday(y, 9), 1); }
/**
 * Ouverture d'une séance un jour donné (minuit UTC du jour) :
 *  utc = minuit UTC (aussi l'ouverture de l'Asie, Tokyo 9 h) ; eu = Londres 8 h ; us = Wall Street 9 h 30 (New York).
 * En hiver, Wall Street ouvre à 15 h 30 heure de Paris ; en été aussi (les deux pays changent d'heure), sauf 2-3 semaines par an.
 */
export function sessionOpen(s: Session, day: number): number | null {
  const wd = new Date(day).getUTCDay();
  if (s !== "utc" && (wd === 0 || wd === 6)) return null; // bourses fermées le week-end
  if (s === "utc") return day;
  if (s === "eu") return day + (euDst(day + 12 * 3_600_000) ? 7 : 8) * 3_600_000;
  return day + ((usDst(day + 18 * 3_600_000) ? 13 : 14) * 60 + 30) * 60_000;
}
/** Dernière ouverture de séance ≤ t (cherche jusqu'à 3 jours en arrière, pour passer le week-end). */
export function sessionStart(s: Session, t: number): number | null {
  const d0 = Math.floor(t / DAY) * DAY;
  for (let k = 0; k < 4; k++) { const o = sessionOpen(s, d0 - k * DAY); if (o != null && o <= t) return o; }
  return null;
}
export const SESSION_NAMES: Record<Session, string> = { utc: "minuit UTC (Asie)", eu: "ouverture de l'Europe", us: "ouverture de Wall Street" };

// ---------------------------------------------------------------------------------------------------
// Nettoyage des réglages (jamais de valeur absurde venant de la base ou de l'app)
// ---------------------------------------------------------------------------------------------------
export function sanitizeSetup(family: SetupFamily, raw: unknown): SetupParams | null {
  if (!raw || typeof raw !== "object") return null;
  const x = raw as Record<string, unknown>;
  switch (family) {
    case "range": return sanitizeRange(raw);
    case "orb": {
      const z = num(x.zoneMin, 15, 120), t = num(x.target, 0.5, 5), w = num(x.window, 1, 12);
      const s = x.session === "eu" || x.session === "us" ? x.session : "utc";
      return z && t && w ? { session: s, zoneMin: Math.round(z / 15) * 15, target: t, window: w, ...hrs(x) } : null;
    }
    case "vwap": {
      const d = num(x.dev, 0.5, 5), s = num(x.stopAtr, 0.5, 5), m = num(x.maxTrend, 0.2, 5);
      return d && s && m ? { dev: d, stopAtr: s, maxTrend: m, ...hrs(x) } : null;
    }
    case "squeeze": {
      const n = num(x.bbPeriod, 8, 60), k = num(x.bbK, 1, 3.5), l = num(x.lookback, 30, 300), p = num(x.pct, 0.02, 0.5), a = num(x.trailAtr, 1, 6);
      return n && k && l && p && a ? { bbPeriod: Math.round(n), bbK: k, lookback: Math.round(l), pct: p, trailAtr: a, ...hrs(x) } : null;
    }
    case "volume": {
      const v = num(x.volMult, 1.2, 10), b = num(x.body, 0.2, 3), a = num(x.trailAtr, 1, 6);
      return v && b && a ? { volMult: v, body: b, trailAtr: a, ...hrs(x) } : null;
    }
    case "funding": {
      const l = num(x.level, 0.000001, 0.001), s = num(x.stopAtr, 0.5, 5), h = num(x.hold, 2, 200);
      return l && s && h ? { level: l, stopAtr: s, hold: Math.round(h) } : null;
    }
  }
}

// ---------------------------------------------------------------------------------------------------
// Signaux (sur la dernière bougie CLÔTURÉE)
// ---------------------------------------------------------------------------------------------------
const noSig = (c: Candle[], reason: string): SetupSignal => { const l = c.at(-1); return { side: null, reason, price: l?.c ?? 0, atr: 0, stop: 0, candleTime: l?.t ?? 0, score: 0 }; };
const closeTime = (c: Candle[]) => c.at(-1)!.t + barMsOf(c);

/** VWAP de la séance (depuis minuit UTC) : prix moyen pondéré par le volume. */
export function sessionVwap(c: Candle[]): { vwap: number; bars: number } | null {
  const last = c.at(-1); if (!last) return null;
  const day = Math.floor(last.t / DAY) * DAY;
  let pv = 0, vv = 0, bars = 0;
  for (let i = c.length - 1; i >= 0 && c[i]!.t >= day; i--) {
    const x = c[i]!, w = x.v && x.v > 0 ? x.v : 1;
    pv += ((x.h + x.l + x.c) / 3) * w; vv += w; bars++;
  }
  return vv > 0 ? { vwap: pv / vv, bars } : null;
}

function orbSignal(c: Candle[], allowShort: boolean, P: OrbParams): SetupSignal {
  const last = c.at(-1)!, bar = barMsOf(c), now = closeTime(c);
  const S = sessionStart(P.session, last.t);
  if (S == null) return noSig(c, `ORB : pas de séance ${SESSION_NAMES[P.session]} (week-end)`);
  const zoneEnd = S + P.zoneMin * 60_000;
  if (P.zoneMin * 60_000 < bar || (P.zoneMin * 60_000) % bar) return noSig(c, "ORB : zone incompatible avec l'unité de temps");
  if (now <= zoneEnd) return noSig(c, `ORB : zone d'ouverture en formation (${SESSION_NAMES[P.session]})`);
  if (now > zoneEnd + P.window * 3_600_000) return noSig(c, `ORB : fenêtre de cassure passée (${SESSION_NAMES[P.session]})`);
  const zone = c.filter((x) => x.t >= S && x.t < zoneEnd);
  if (zone.length !== P.zoneMin * 60_000 / bar) return noSig(c, "ORB : zone d'ouverture incomplète");
  const hi = Math.max(...zone.map((x) => x.h)), lo = Math.min(...zone.map((x) => x.l)), width = hi - lo;
  const a = atr(c, STRATEGY.atrPeriod).at(-1)!;
  if (width < 0.3 * a || width / last.c < 0.001) return noSig(c, `ORB : zone trop étroite (${fmt(lo)} – ${fmt(hi)})`);
  if (width > 4 * a) return noSig(c, `ORB : zone trop large (${fmt(lo)} – ${fmt(hi)})`);
  const after = c.filter((x) => x.t >= zoneEnd && x.t < last.t);
  const fresh = (above: boolean) => after.every((x) => (above ? x.c <= hi : x.c >= lo)); // première cassure seulement
  const why = (d: string) => `ORB ${SESSION_NAMES[P.session]} : cassure ${d} de la zone ${P.zoneMin} min (${fmt(lo)} – ${fmt(hi)})`;
  if (last.c > hi && fresh(true)) return { side: "long", reason: why("haussière"), price: last.c, atr: a, stop: lo, target: last.c + P.target * width, candleTime: last.t, score: (last.c - hi) / width };
  if (allowShort && last.c < lo && fresh(false)) return { side: "short", reason: why("baissière"), price: last.c, atr: a, stop: hi, target: last.c - P.target * width, candleTime: last.t, score: (lo - last.c) / width };
  return noSig(c, `ORB : prix dans la zone d'ouverture (${fmt(lo)} – ${fmt(hi)})`);
}

function vwapSignal(c: Candle[], allowShort: boolean, P: VwapParams): SetupSignal {
  const last = c.at(-1)!, closes = c.map((x) => x.c);
  const a = atr(c, STRATEGY.atrPeriod).at(-1)!;
  const V = sessionVwap(c);
  if (!V || V.bars < 4) return noSig(c, "VWAP : séance trop jeune (attente de 4 bougies après minuit UTC)");
  const strength = Math.abs(ema(closes, STRATEGY.emaFast).at(-1)! - ema(closes, STRATEGY.emaSlow).at(-1)!) / a;
  if (strength > P.maxTrend) return noSig(c, `VWAP : marché en tendance (force ${strength.toFixed(1)} > ${P.maxTrend})`);
  const dev = (last.c - V.vwap) / a;
  if (dev <= -P.dev) return { side: "long", reason: `VWAP : prix ${Math.abs(dev).toFixed(1)} ATR sous le prix moyen du jour (${fmt(V.vwap)}), retour attendu`, price: last.c, atr: a, stop: last.c - P.stopAtr * a, target: V.vwap, candleTime: last.t, score: -dev };
  if (allowShort && dev >= P.dev) return { side: "short", reason: `VWAP : prix ${dev.toFixed(1)} ATR au-dessus du prix moyen du jour (${fmt(V.vwap)}), retour attendu`, price: last.c, atr: a, stop: last.c + P.stopAtr * a, target: V.vwap, candleTime: last.t, score: dev };
  return noSig(c, `VWAP : prix proche du prix moyen du jour (${fmt(V.vwap)}, écart ${dev.toFixed(1)} ATR)`);
}

/** Largeur des bandes de Bollinger (en % du milieu) sur les `n` dernières bougies. */
function bandwidths(closes: number[], P: SqueezeParams, n: number): number[] {
  const out: number[] = [];
  for (let i = closes.length - n; i < closes.length; i++) {
    if (i < P.bbPeriod) continue;
    const b = bollinger(closes.slice(i + 1 - P.bbPeriod, i + 1), P.bbPeriod, P.bbK);
    out.push((b.up - b.lo) / b.mid);
  }
  return out;
}

function squeezeSignal(c: Candle[], allowShort: boolean, P: SqueezeParams): SetupSignal {
  const last = c.at(-1)!, closes = c.map((x) => x.c);
  if (c.length < P.lookback + P.bbPeriod + 2) return noSig(c, "compression : historique insuffisant");
  const a = atr(c, STRATEGY.atrPeriod).at(-1)!;
  const bw = bandwidths(closes.slice(0, -1), P, P.lookback); // compression jugée AVANT la bougie de cassure
  const prev = bw.at(-1)!, rank = bw.filter((x) => x <= prev).length / bw.length;
  if (rank > P.pct) return noSig(c, `compression : bandes pas assez resserrées (${Math.round(rank * 100)} % des cas, seuil ${Math.round(P.pct * 100)} %)`);
  const b = bollinger(closes, P.bbPeriod, P.bbK);
  const dist = (side: Side) => Math.max(a, Math.abs(last.c - b.mid)) * (side === "long" ? 1 : -1);
  if (last.c > b.up) return { side: "long", reason: `compression des bandes puis cassure haussière (${fmt(b.up)})`, price: last.c, atr: a, stop: last.c - dist("long"), candleTime: last.t, score: (last.c - b.up) / a };
  if (allowShort && last.c < b.lo) return { side: "short", reason: `compression des bandes puis cassure baissière (${fmt(b.lo)})`, price: last.c, atr: a, stop: last.c - dist("short"), candleTime: last.t, score: (b.lo - last.c) / a };
  return noSig(c, `compression en cours, pas encore de cassure (${fmt(b.lo)} – ${fmt(b.up)})`);
}

function volumeSignal(c: Candle[], allowShort: boolean, P: VolumeParams): SetupSignal {
  const last = c.at(-1)!;
  const prev = c.slice(-21, -1).map((x) => x.v ?? 0);
  if (!last.v || prev.some((v) => !(v > 0))) return noSig(c, "volume : données de volume indisponibles");
  const avg = prev.reduce((s, v) => s + v, 0) / prev.length, ratio = last.v / avg;
  const a = atr(c, STRATEGY.atrPeriod).at(-1)!, body = Math.abs(last.c - last.o), range = Math.max(last.h - last.l, 1e-12);
  if (ratio < P.volMult) return noSig(c, `volume normal (×${ratio.toFixed(1)}, seuil ×${P.volMult})`);
  if (body < P.body * a) return noSig(c, `volume ×${ratio.toFixed(1)} mais bougie trop petite`);
  const clamp = (d: number) => Math.min(3 * a, Math.max(0.5 * a, d));
  if (last.c > last.o && (last.h - last.c) / range <= 0.3)
    return { side: "long", reason: `explosion du volume (×${ratio.toFixed(1)}) avec une forte bougie haussière`, price: last.c, atr: a, stop: last.c - clamp(last.c - last.l), candleTime: last.t, score: ratio };
  if (allowShort && last.c < last.o && (last.c - last.l) / range <= 0.3)
    return { side: "short", reason: `explosion du volume (×${ratio.toFixed(1)}) avec une forte bougie baissière`, price: last.c, atr: a, stop: last.c + clamp(last.h - last.c), candleTime: last.t, score: ratio };
  return noSig(c, `volume ×${ratio.toFixed(1)} mais clôture indécise`);
}

/** Financement moyen sur les 8 dernières heures connues à l'instant t. */
export function fundingAt(f: { t: number; r: number }[] | undefined, t: number): number | null {
  if (!f?.length) return null;
  let hi = f.length - 1; while (hi >= 0 && f[hi]!.t > t) hi--;
  if (hi < 7 || t - f[hi]!.t > 3 * 3_600_000) return null;
  let s = 0; for (let k = hi - 7; k <= hi; k++) s += f[k]!.r;
  return s / 8;
}

function fundingSignal(c: Candle[], allowShort: boolean, P: FundingParams, extra?: Extra): SetupSignal {
  const last = c.at(-1)!, closes = c.map((x) => x.c);
  const f = fundingAt(extra?.funding, closeTime(c));
  if (f == null) return noSig(c, "funding : données de financement indisponibles");
  const a = atr(c, STRATEGY.atrPeriod).at(-1)!, m20 = ema(closes, 20).at(-1)!;
  const yearly = (f * 24 * 365 * 100).toFixed(0);
  if (allowShort && f >= P.level && last.c < m20)
    return { side: "short", reason: `funding extrême (${yearly} %/an) : la foule est massivement à l'achat, le prix commence à céder`, price: last.c, atr: a, stop: last.c + P.stopAtr * a, target: last.c - 2 * P.stopAtr * a, candleTime: last.t, score: f / P.level };
  if (f <= -P.level && last.c > m20)
    return { side: "long", reason: `funding extrême (${yearly} %/an) : la foule est massivement à la vente, le prix commence à remonter`, price: last.c, atr: a, stop: last.c - P.stopAtr * a, target: last.c + 2 * P.stopAtr * a, candleTime: last.t, score: -f / P.level };
  return noSig(c, `funding normal (${yearly} %/an)`);
}

/** Signal d'une famille, avec les filtres communs (volatilité extrême, heures creuses). */
export function setupSignal(family: SetupFamily, c: Candle[], allowShort: boolean, P: SetupParams, extra?: Extra): SetupSignal {
  const last = c.at(-1);
  if (!last || c.length < STRATEGY.emaSlow + 5) return noSig(c, `historique insuffisant (${c.length} bougies)`);
  if (family === "range") return rangeSignal(c, allowShort, P as RangeParams);
  const a = atr(c, STRATEGY.atrPeriod).at(-1)!, T = tfOf(c);
  if (a / last.c > T.maxAtrPct) return noSig(c, `marché trop agité (ATR ${((a / last.c) * 100).toFixed(2)} %)`);
  if (a / last.c < T.minAtrPct / 4) return noSig(c, `marché quasi immobile (ATR ${((a / last.c) * 100).toFixed(2)} %)`);
  if ((P as { hours?: string }).hours === "actives" && !activeHour(closeTime(c))) return noSig(c, "heures creuses (nuit ou week-end) : pas d'entrée");
  switch (family) {
    case "orb": return orbSignal(c, allowShort, P as OrbParams);
    case "vwap": return vwapSignal(c, allowShort, P as VwapParams);
    case "squeeze": return squeezeSignal(c, allowShort, P as SqueezeParams);
    case "volume": return volumeSignal(c, allowShort, P as VolumeParams);
    case "funding": return fundingSignal(c, allowShort, P as FundingParams, extra);
  }
}

/**
 * Sortie d'une position « à objectif », jugée à la clôture de chaque bougie (le stop et l'objectif sont aussi
 * surveillés chaque minute avec le prix en direct). Renvoie la raison, ou null pour garder la position.
 */
export function setupExit(family: SetupFamily, c: Candle[], side: Side, P: SetupParams, heldBars: number, openedAt: number): string | null {
  const bar = barMsOf(c);
  switch (family) {
    case "range": return rangeExit(c, side, P as RangeParams, heldBars);
    case "orb": return heldBars * bar >= (P as OrbParams).window * 2 * 3_600_000 ? "orb_temps" : null;
    case "vwap": {
      const V = sessionVwap(c), last = c.at(-1)!;
      if (Math.floor(last.t / DAY) !== Math.floor(openedAt / DAY)) return "vwap_temps"; // nouvelle journée : nouveau VWAP
      if (V && (side === "long" ? last.c >= V.vwap : last.c <= V.vwap)) return "vwap_atteint";
      return null;
    }
    case "funding": return heldBars >= (P as FundingParams).hold ? "funding_temps" : null;
    default: return null; // familles suiveuses : gérées comme la tendance
  }
}

/** Réglages de stop suiveur (pour trailStop) d'une famille suiveuse. */
export const trailParams = (P: SetupParams): Params => ({ breakout: 0, trailAtr: (P as SqueezeParams).trailAtr ?? 3, minTrend: 0 });

// ---------------------------------------------------------------------------------------------------
// Backtest générique : mêmes signaux et mêmes sorties que les bots réels, frais, portage, prise partielle,
// pause après perte, filtre de marché et taille selon la volatilité compris.
// ---------------------------------------------------------------------------------------------------
export function backtestSetup(family: SetupFamily, candles: Candle[], P: SetupParams, o: SimOpts & { extra?: Extra }): BacktestResult {
  const T = tfOf(candles), trailing = TRAILING.includes(family);
  let equity = 1, peak = 1, maxDd = 0, cooldownUntil = 0;
  const log: BacktestResult["log"] = [];
  type Pos = { side: Side; entry: number; stop: number; target?: number; best: number; risk: number; size: number; i: number; t: number; partial: boolean };
  let pos: Pos | null = null;
  const atrs = atr(candles, STRATEGY.atrPeriod);
  const start = STRATEGY.emaSlow + 5;
  const close = (exit: number, reason: string, t: number, frac = 1) => {
    const move = perpsChange(pos!.side, pos!.entry, exit);
    const pnl = pos!.size * frac * (move - 2 * o.feePct - (o.hourlyCost ?? 0) * ((t - pos!.t) / 3_600_000));
    equity *= 1 + pnl;
    log.push({ side: pos!.side, entry: pos!.entry, exit, pnlPct: pnl * 100, reason, t });
    return pnl;
  };
  for (let i = start; i < candles.length; i++) {
    const c = candles[i]!;
    if (pos) {
      const long = pos.side === "long";
      let exit: number | null = null, reason = "";
      if (long ? c.l <= pos.stop : c.h >= pos.stop) { exit = long ? Math.min(c.o, pos.stop) : Math.max(c.o, pos.stop); reason = (long ? pos.stop >= pos.entry : pos.stop <= pos.entry) ? "trailing_stop" : "stop_loss"; }
      else if (pos.target != null && (long ? c.h >= pos.target : c.l <= pos.target)) { exit = long ? Math.max(c.o, pos.target) : Math.min(c.o, pos.target); reason = "objectif"; }
      else if (!trailing) {
        const r = setupExit(family, candles.slice(Math.max(0, i - 400), i + 1), pos.side, P, i - pos.i, pos.t);
        if (r) { exit = c.c; reason = r; }
      } else {
        const r = pos.risk > 0 ? (long ? c.c - pos.entry : pos.entry - c.c) / pos.risk : 0;
        if ((c.t - pos.t) / 3_600_000 >= T.maxHoldHours && r < STRATEGY.minProgressR) { exit = c.c; reason = "time_stop"; }
      }
      if (exit !== null) {
        const pnl = close(exit, reason, c.t);
        if (pnl < 0 && !o.noCooldown) cooldownUntil = c.t + T.cooldownMs;
        pos = null;
      } else if (trailing) {
        const tgt = long ? pos.entry + PARTIAL.atR * pos.risk : pos.entry - PARTIAL.atR * pos.risk;
        if (o.partial && !pos.partial && (long ? c.h >= tgt : c.l <= tgt)) {
          pos.partial = true;
          if (o.partial === "half") { close(tgt, "prise_partielle", c.t, PARTIAL.fraction); pos.size *= 1 - PARTIAL.fraction; }
          pos.stop = long ? Math.max(pos.stop, pos.entry) : Math.min(pos.stop, pos.entry);
        }
        pos.best = long ? Math.max(pos.best, c.c) : Math.min(pos.best, c.c);
        pos.stop = trailStop(pos.side, pos.stop, pos.best, atrs[i]!, trailParams(P));
      }
    }
    if (!pos && c.t >= cooldownUntil && !o.blockedAt?.(c.t)) {
      const win = candles.slice(Math.max(0, i - 400), i + 1);
      const sig = setupSignal(family, win, o.allowShort, P, o.extra);
      if (sig.side) {
        const dist = Math.abs(sig.price - sig.stop) / sig.price;
        if (dist > 0) {
          const risk = (o.risk ?? (family === "range" ? 0.01 : RISK.perTrade)) * (o.noVolScale ? 1 : volScale(win));
          pos = { side: sig.side, entry: c.c, stop: sig.stop, target: sig.target, best: c.c, risk: Math.abs(c.c - sig.stop), size: Math.min(risk / dist, o.leverageCap ?? RISK.maxSpotFraction), i, t: c.t, partial: false };
        }
      }
    }
    peak = Math.max(peak, equity);
    maxDd = Math.max(maxDd, 1 - equity / peak);
  }
  return summarize(log, { equity, maxDd }, candles[start], candles.at(-1));
}

/** Description lisible des réglages d'une famille. */
export function describeSetup(family: SetupFamily, P: SetupParams, kind: "spot" | "perps"): string {
  const both = kind === "perps" ? ", long et short" : ", achat seulement";
  const h = (P as { hours?: string }).hours === "actives" ? ", heures actives seulement" : "";
  switch (family) {
    case "range": { const p = P as RangeParams; return `range : sortie des bandes de Bollinger (${p.bbPeriod}, ${p.bbK}), retour à la moyenne, stop ${p.stopAtr} ATR, seulement si force < ${p.maxTrend} ATR${both}${h}`; }
    case "orb": { const p = P as OrbParams; return `ORB ${SESSION_NAMES[p.session]} : zone des ${p.zoneMin} premières minutes, cassure dans les ${p.window} h, objectif ${p.target} × la zone, stop de l'autre côté${both}${h}`; }
    case "vwap": { const p = P as VwapParams; return `retour au VWAP : écart ≥ ${p.dev} ATR du prix moyen du jour, objectif le VWAP, stop ${p.stopAtr} ATR, seulement si force < ${p.maxTrend} ATR${both}${h}`; }
    case "squeeze": { const p = P as SqueezeParams; return `cassure de compression : bandes (${p.bbPeriod}, ${p.bbK}) parmi les ${Math.round(p.pct * 100)} % les plus serrées des ${p.lookback} dernières bougies, stop suiveur ${p.trailAtr} ATR${both}${h}`; }
    case "volume": { const p = P as VolumeParams; return `momentum de volume : volume ≥ ×${p.volMult} la moyenne et bougie ≥ ${p.body} ATR, stop suiveur ${p.trailAtr} ATR${both}${h}`; }
    case "funding": { const p = P as FundingParams; return `funding extrême ≥ ${(p.level * 24 * 365 * 100).toFixed(0)} %/an : pari contre la foule si le prix confirme, stop ${p.stopAtr} ATR, objectif 2 × le risque, ${p.hold} bougies maximum`; }
  }
}

export const FAMILY_NAMES: Record<string, string> = { tendance: "tendance", rsi: "RSI", range: "range", orb: "ORB", vwap: "VWAP", squeeze: "compression", volume: "volume", funding: "funding" };
