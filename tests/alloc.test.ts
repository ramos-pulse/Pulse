import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyStats, familyWeights, mathShare, pickMarket, recordCycle, VALID, type Market } from "../supabase/functions/pulse/engine/research.ts";

const mk = (product: string, interval: "1h" | "15m" = "1h"): Market => ({ name: product, product, symbol: product, kind: "spot", interval, feePct: 0.001, hourlyCost: 0, cap: 1 });

test("répartition : une famille qui échoue toujours garde 5 %, celle qui trouve prend plus de temps", () => {
  const st = emptyStats(), m = mk("SOL-USD");
  const rows = [...Array(200)].map(() => ({ family: "rsi" as const, verdict: "rejetée", origin: "chercheur" }))
    .concat([...Array(100)].map((_, i) => ({ family: "squeeze" as const, verdict: i < 15 ? "prometteuse" : "rejetée", origin: "chercheur" })));
  recordCycle(st, m, rows, Date.now());
  const w = familyWeights(st, "spot", "1h", ["tendance", "rsi", "orb", "vwap", "squeeze", "volume"]);
  assert.ok(w.rsi! >= 0.049 && w.rsi! < 0.08, `RSI ${w.rsi}`);
  assert.ok(w.squeeze! > 0.2, `compression ${w.squeeze}`);
  assert.ok(Math.abs(Object.values(w).reduce((a, b) => a + b!, 0) - 1) < 1e-9);
});

test("répartition : le marché le moins récemment étudié passe d'abord, un marché indisponible ne bloque pas", () => {
  const st = emptyStats(), now = Date.now(), A = mk("A"), B = mk("B"), C = mk("C");
  recordCycle(st, A, [], now - 10 * 3_600_000);
  recordCycle(st, B, [], now - 1 * 3_600_000);
  recordCycle(st, C, [], now - 5 * 3_600_000);
  assert.equal(pickMarket([A, B, C], st, now, () => 0.5).product, "A");
  recordCycle(st, A, [], now); // visité (même sans résultat : historique indisponible)
  assert.equal(pickMarket([A, B, C], st, now, () => 0.5).product, "C");
  // jamais étudié : prioritaire
  assert.equal(pickMarket([A, B, C, mk("D")], st, now, () => 0.5).product, "D");
});

test("répartition : le mathématicien garde entre 15 et 50 % du temps", () => {
  const st = emptyStats(), m = mk("X", "15m");
  recordCycle(st, m, [...Array(110)].map(() => ({ family: "vwap" as const, verdict: "rejetée", origin: "mathématicien" }))
    .concat([...Array(100)].map((_, i) => ({ family: "squeeze" as const, verdict: i < 10 ? "prometteuse" : "rejetée", origin: "chercheur" }))), Date.now());
  const s = mathShare(st, "spot", "15m");
  assert.ok(s >= 0.15 && s < 0.3, `part ${s}`);
  assert.equal(mathShare(emptyStats(), "perps", "1h"), 0.5);
});

test("validation : 8 trades sur la période jamais vue pour « prometteuse »", () => {
  assert.equal(VALID.minTestTrades, 8);
});

test("mathématicien : en régime « hasard », seulement les idées valables partout (compression, ORB de minuit)", async () => {
  const { propose } = await import("../supabase/functions/pulse/engine/math.ts");
  const c = [...Array(800)].map((_, i) => { const p = 100 + Math.sin(i * 1.7) * 2 + Math.cos(i * 0.31) * 3; return { t: i * 900_000, o: p, h: p * 1.004, l: p * 0.996, c: p, v: 1000 }; });
  const m = { name: "X", product: "X", symbol: "X", kind: "perps" as const, interval: "15m" as const, feePct: 0.0007, hourlyCost: 0, cap: 3 };
  const ins = { regime: "hasard" as const, hurst: 0.5, ac1: 0, halfLife: null, vr: [], bestQ: 12, significant: false, bars: 800, note: "aucun effet" };
  const ideas = propose(c, m, ins, { aggressive: true, fast: true }).map((p) => p.idea);
  assert.ok(ideas.length > 0 && ideas.every((i) => i === "compression" || i === "orb"), ideas.join(","));
});

test("mathématicien : une idée qui échoue toujours devient rare (jamais moins de 10 %), son diagnostic se lit en clair", async () => {
  const { emptyStats, recordIdeas, ideaChance } = await import("../supabase/functions/pulse/engine/research.ts");
  const { regimeFitLabel } = await import("../supabase/functions/pulse/engine/math.ts");
  const st = emptyStats();
  recordIdeas(st, "perps", "15m", [...Array(46)].map(() => ({ idea: "range-agressif", verdict: "rejetée" })));
  recordIdeas(st, "perps", "15m", [...Array(46)].map((_, i) => ({ idea: "compression", verdict: i < 5 ? "prometteuse" : "rejetée" })));
  assert.ok(ideaChance(st, "perps", "15m", "range-agressif") < 0.4); // 46 échecs : ~38 %
  recordIdeas(st, "perps", "15m", [...Array(200)].map(() => ({ idea: "range-agressif", verdict: "rejetée" })));
  assert.ok(ideaChance(st, "perps", "15m", "range-agressif") <= 0.15); // ~240 échecs : proche du plancher de 10 %
  assert.equal(ideaChance(st, "perps", "15m", "compression"), 1);
  assert.equal(ideaChance(st, "perps", "15m", "jamais-essayée"), 1);
  assert.equal(regimeFitLabel("tendance", "tendance"), "favorable");
  assert.equal(regimeFitLabel("range", "tendance"), "défavorable");
  assert.equal(regimeFitLabel("squeeze", "hasard"), "neutre");
});
