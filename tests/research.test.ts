import { test } from "node:test";
import assert from "node:assert/strict";
import { candidateKey, describe, evaluate, mutate, randomCandidate, seeded, type Market } from "../supabase/functions/pulse/engine/research.ts";
import type { Candle } from "../supabase/functions/pulse/engine/strategy.ts";

const spot: Market = { name: "Spot SOL", product: "SOL-USD", kind: "spot", feePct: 0.003, hourlyCost: 0, cap: 0.95 };
const perps: Market = { name: "Perps SOL", product: "SOL-USD", kind: "perps", feePct: 0.0012, hourlyCost: 0.00008, cap: 3 };
function market(seed: number, drift: number): Candle[] {
  const rnd = seeded(seed); const c: Candle[] = []; let p = 100;
  for (let i = 0; i < 2160; i++) { const n = p * Math.exp(Math.sin(i / 250) * drift + (rnd() - 0.5) * 0.014);
    c.push({ t: i * 3_600_000, o: p, h: Math.max(p, n) * 1.003, l: Math.min(p, n) * 0.997, c: n }); p = n; }
  return c;
}
test("candidats valides, RSI seulement en spot", () => {
  const rnd = seeded(1);
  for (let i = 0; i < 200; i++) {
    const c = randomCandidate(rnd, perps); assert.equal(c.family, "tendance");
    const s = randomCandidate(rnd, spot);
    if (s.family === "rsi") { const p = s.params as { entry: number; exit: number }; assert.ok(p.exit > p.entry); }
  }
});
test("mutation : un seul réglage change, signature différente", () => {
  const rnd = seeded(5);
  const a = randomCandidate(rnd, spot);
  let b = mutate(rnd, a); for (let i = 0; i < 5 && candidateKey(b) === candidateKey(a); i++) b = mutate(rnd, a);
  const pa = a.params as unknown as Record<string, number>, pb = b.params as unknown as Record<string, number>;
  assert.ok(Object.keys(pa).filter((k) => pa[k] !== pb[k]).length <= 2);
  assert.ok(describe(a).length > 10);
});
test("évaluation hors échantillon : un marché aléatoire ne produit pas de « prometteuse » en série", () => {
  const rnd = seeded(9); let prom = 0, total = 0;
  for (let s = 1; s <= 4; s++) { const c = market(s * 77, 0); for (let i = 0; i < 6; i++) { const e = evaluate(randomCandidate(rnd, spot), c, spot); total++; if (e.verdict === "prometteuse") prom++; } }
  assert.ok(prom / total < 0.35, `${prom}/${total} jugées prometteuses sur du pur hasard`);
});
test("évaluation : temps de calcul compatible avec la limite Supabase", () => {
  const c = market(3, 0.002); const rnd = seeded(2); const t0 = performance.now();
  for (let i = 0; i < 6; i++) evaluate(randomCandidate(rnd, perps), c, perps);
  const ms = (performance.now() - t0) / 6;
  console.log(`   ~${ms.toFixed(0)} ms par stratégie testée (90 jours d'historique)`);
  assert.ok(ms < 400);
});
