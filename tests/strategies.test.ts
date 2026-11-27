import { test } from "node:test";
import assert from "node:assert/strict";
import { applyTransfer, backtestRange, detectTransfer, loadMemory, perpsSizing, rangeExit, rangeSignal, sanitizePerpsPlan, sanitizeTrend, trendSignal, TOKENS, type Candle } from "../supabase/functions/pulse/engine/strategy.ts";
import { describe as describeStrat, tempo, evaluate } from "../supabase/functions/pulse/engine/research.ts";

// marché en range réaliste : oscillation + bruit aléatoire reproductible (une sinusoïde pure ne sort jamais de ses bandes)
let seed = 42; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const noise = Array.from({ length: 2000 }, () => (rnd() + rnd() + rnd() - 1.5) * 1.2);
const ranging = (i: number) => 100 * (1 + 0.01 * Math.sin(i / 3)) + noise[i]!;
const mk = (f: (i: number) => number, n = 400, w = 0.004): Candle[] => Array.from({ length: n }, (_, i) => { const c = f(i), o = f(Math.max(0, i - 1)); return { t: i * 3_600_000, o, h: Math.max(o, c) * (1 + w), l: Math.min(o, c) * (1 - w), c }; });

test("dépôts et retraits : un transfert n'est ni un gain ni une perte", () => {
  const mem = loadMemory({ v: 3, dayStartValue: 28, curve: [{ t: 0, v: 28 }] });
  assert.equal(detectTransfer(mem, 28, 0.05, 150, 28), 0, "pas de référence au premier tick");
  mem.lastUsdc = 28; mem.lastSol = 0.05;
  assert.equal(detectTransfer(mem, 27.9, 0.0499, 150, 28), 0, "frais et arrondis ignorés");
  const d = detectTransfer(mem, 8, 0.05, 150, 8);
  assert.equal(d, -20, "retrait de 20 $ détecté");
  applyTransfer(mem, d);
  assert.equal(mem.dayStartValue, 8, "la perte du jour repart du nouveau solde (le bot n'est plus bloqué)");
  assert.equal(mem.curve![0]!.v, 8, "la courbe est décalée, pas cassée");
  assert.equal(detectTransfer({ ...mem, lastUsdc: 26, lastSol: 0 } as never, 46, 0, 150, 46), 20, "dépôt de 20 $ détecté");
});
test("perps petit capital : position minimale de Jupiter acceptée si la perte au stop reste sous le plafond", () => {
  const s3 = perpsSizing(26.16, 26.16, 100, 97, 0.0112, 3, 0.02)!; // stop à 3 %
  assert.ok(s3 && s3.collateral === 10 && Math.abs(s3.risk - (11 * 0.03) / 26.16) < 1e-9, JSON.stringify(s3));
  assert.equal(perpsSizing(26.16, 26.16, 100, 95, 0.0112, 3, 0.02), null, "stop à 5 % : 2,1 % > plafond 2 %, refusé");
  const big = perpsSizing(1000, 1000, 100, 97, 0.015, 3, 0.02)!;
  assert.ok(Math.abs(big.risk - 0.015) < 1e-9, "gros capital : risque exact, inchangé");
});
test("achat sur repli : entre quand le prix touche la moyenne 20 puis repart, en tendance", () => {
  // tendance haussière régulière, puis un repli de 3 bougies sur la moyenne et un rebond
  const f = (i: number) => (i < 395 ? 100 * 1.002 ** i : i < 398 ? 100 * 1.002 ** 394 * (1 - 0.012 * (i - 394)) : 100 * 1.002 ** 394 * 0.975);
  const c = mk(f, 400, 0.003);
  c[399] = { ...c[399]!, c: c[398]!.c * 1.02, h: c[398]!.c * 1.025 };
  const p = sanitizeTrend({ breakout: 24, trailAtr: 3, minTrend: 0.3, entry: "repli" })!;
  assert.equal(p.entry, "repli");
  const sig = trendSignal(c, true, p);
  assert.equal(sig.side, "long", sig.reason);
  assert.match(sig.reason, /repli/);
  assert.equal(trendSignal(c, true, { ...p, entry: undefined }).side, null, "la même bougie n'est pas une cassure");
});
test("range : achète sous la bande basse, vend au-dessus de la bande haute, sort au retour à la moyenne", () => {
  const P = { bbPeriod: 20, bbK: 2, stopAtr: 1.5, maxTrend: 1.5 };
  const flat = (i: number) => 100 * (1 + 0.01 * Math.sin(i / 3));
  const lo = mk((i) => (i === 399 ? 96.5 : flat(i)), 400, 0.002), hi = mk((i) => (i === 399 ? 103.5 : flat(i)), 400, 0.002);
  assert.equal(rangeSignal(lo, true, P).side, "long", rangeSignal(lo, true, P).reason);
  assert.equal(rangeSignal(hi, true, P).side, "short");
  assert.equal(rangeSignal(hi, false, P).side, null, "pas de short sans autorisation");
  assert.equal(rangeSignal(mk((i) => 100 * 1.004 ** i), true, P).side, null, "marché en tendance : pas de range");
  assert.equal(rangeExit(mk(flat, 60), "long", P, 1), "objectif");
  const bt = backtestRange(mk(ranging, 1200, 0.003), P, { allowShort: true, feePct: 0.0012, hourlyCost: 0.00008, leverageCap: 3, hoursPerBar: 1 });
  assert.ok(bt.trades > 10 && bt.log.every((t) => Number.isFinite(t.pnlPct)), `trades ${bt.trades}`);
});
test("range dans le chercheur : description, rythme, plan perps", () => {
  const P = { bbPeriod: 14, bbK: 2, stopAtr: 1.5, maxTrend: 1 };
  assert.match(describeStrat({ family: "range", params: P, kind: "perps", interval: "1h" }), /Bollinger/);
  assert.equal(tempo({ interval: "15m", family: "range", params: P }), 3);
  const pl = sanitizePerpsPlan({ asset: "SOL", family: "range", params: P, interval: "1h", source: "x" })!;
  assert.equal(pl.family, "range"); assert.deepEqual(pl.params, P);
  assert.equal(sanitizePerpsPlan({ asset: "SOL", params: { breakout: 24, trailAtr: 3, minTrend: 1 }, interval: "1h", source: "x" })!.family, undefined, "ancien plan de tendance inchangé");
  const ev = evaluate({ market: "Perps SOL", product: "SOL-USD", symbol: "SOL", kind: "perps", interval: "1h", family: "range", params: P }, mk(ranging, 1500, 0.003),
    { name: "Perps SOL", product: "SOL-USD", symbol: "SOL", kind: "perps", interval: "1h", feePct: 0.0012, hourlyCost: 0.00008, cap: 3 });
  assert.ok(ev.train.trades > 0 && ev.test.trades > 0, "évalué hors échantillon comme les autres");
});
test("nouveaux tokens : adresses et décimales vérifiées", () => {
  const want: Record<string, [string, number]> = { ORCA: ["orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE", 6], HNT: ["hntyVP6YFm1Hg25TN9WGLqM12b8TQmcknKrdu1oxWux", 8],
    TRUMP: ["6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN", 6], PENGU: ["2zMMhcVQEXDtdE6vsFS7S7D5oUodfJHE8vd1gnBouauv", 6] };
  for (const [sym, [mint, dec]] of Object.entries(want)) {
    const t = TOKENS.find((x) => x.symbol === sym)!;
    assert.equal(t.mint, mint); assert.equal(t.decimals, dec); assert.equal(t.verify, true, `${sym} revérifié sur Jupiter avant achat`);
  }
  assert.equal(new Set(TOKENS.map((t) => t.mint)).size, TOKENS.length, "aucun doublon");
});
