import { test } from "node:test";
import assert from "node:assert/strict";
import { analyze, hurst, varianceRatio, halfLife, propose, quantile, snap } from "../supabase/functions/pulse/engine/math.ts";
import { seeded } from "../supabase/functions/pulse/engine/research.ts";

// bruit gaussien reproductible
const gauss = (rnd: () => number) => () => Math.sqrt(-2 * Math.log(rnd() || 1e-12)) * Math.cos(2 * Math.PI * rnd());
function series(n: number, kind: "hasard" | "tendance" | "retour") {
  const g = gauss(seeded(kind.length * 977 + 3)); const c = []; let lp = Math.log(100), prev = 0, dev = 0;
  for (let i = 0; i < n; i++) {
    let r: number;
    if (kind === "hasard") r = 0.01 * g();
    else if (kind === "tendance") r = prev = 0.35 * prev + 0.01 * g();      // rendements qui se prolongent
    else { const nd = 0.85 * dev + 0.01 * g(); r = nd - dev; dev = nd; }     // écart qui revient vers 0 (demi-vie ≈ 4)
    const o = Math.exp(lp); lp += r; const cl = Math.exp(lp);
    c.push({ t: i * 3_600_000, o, h: Math.max(o, cl) * 1.002, l: Math.min(o, cl) * 0.998, c: cl });
  }
  return c;
}
const ret = (c: { c: number }[]) => c.slice(1).map((x, i) => Math.log(x.c / c[i]!.c));
const market = { name: "Spot SOL", product: "SOL-USD", symbol: "SOL", kind: "spot" as const, interval: "1h" as const, feePct: 0.1, hourlyCost: 0, cap: 1 };

test("outils de base", () => {
  assert.equal(quantile([1, 2, 3, 4, 5], 0.5), 3); assert.equal(snap(27, [12, 24, 36]), 24);
});
test("marche au hasard : VR ≈ 1, Hurst ≈ 0,5, aucun effet significatif", () => {
  const c = series(3000, "hasard"), r = ret(c);
  assert.ok(Math.abs(varianceRatio(r, 24).vr - 1) < 0.25); assert.ok(Math.abs(hurst(r) - 0.5) < 0.06);
  assert.equal(analyze(c).regime, "hasard");
});
test("marché à tendance : VR > 1 significatif, Hurst > 0,5 ⇒ propose du suivi de tendance", () => {
  const c = series(3000, "tendance"), ins = analyze(c);
  assert.equal(ins.regime, "tendance"); assert.ok(ins.hurst > 0.55 && ins.significant);
  const p = propose(c, market);
  assert.ok(p.length >= 1 && p.every((x) => x.candidate.family === "tendance"));
});
test("marché qui revient à la moyenne : VR < 1, demi-vie retrouvée ⇒ propose du RSI", () => {
  const c = series(3000, "retour"), ins = analyze(c);
  assert.equal(ins.regime, "retour à la moyenne"); assert.ok(ins.hurst < 0.45);
  const hl = halfLife(c, 50)!; assert.ok(hl > 1 && hl < 12, `demi-vie ${hl}`);
  const p = propose(c, market);
  assert.ok(p.some((x) => x.candidate.family === "rsi")); assert.ok(p.every((x) => x.rationale.length > 20));
  // en perps (pas de RSI) : un marché qui revient à la moyenne reçoit des stratégies RANGE, pas de tendance
  const pp = propose(c, { ...market, kind: "perps" });
  assert.ok(pp.length >= 1 && pp.every((x) => x.candidate.family === "range"), JSON.stringify(pp.map((x) => x.candidate.family)));
});
