import { test } from "node:test";
import assert from "node:assert/strict";
import { AGGRESSIVE, backtest, loadPerpsConfig, perpsSizing, sideMult, type Candle } from "../supabase/functions/pulse/engine/strategy.ts";

test("barre longs/shorts", () => {
  assert.equal(sideMult(0, "long"), 1); assert.equal(sideMult(0, "short"), 1);
  assert.equal(sideMult(50, "long"), 1); assert.equal(sideMult(50, "short"), 0.5);
  assert.equal(sideMult(-100, "long"), 0); assert.equal(sideMult(-100, "short"), 1);
  assert.deepEqual(loadPerpsConfig({ mode: "agressif", bias: 999 }), { mode: "agressif", aggr: 3, maxLev: 3, pilotAggressive: false, bias: 100, trend: null, autopilot: false, extraSoft: false, dailyStop: false, plans: [], plan: null, maxPositions: 3, vaultPct: 25, partialTp: true }); // ancien « agressif » → niveau 3
  assert.deepEqual(loadPerpsConfig(null), { mode: "normal", aggr: 1, maxLev: 3, pilotAggressive: false, bias: 0, trend: null, autopilot: false, extraSoft: false, dailyStop: false, plans: [], plan: null, maxPositions: 3, vaultPct: 25, partialTp: true });
});
test("mode agressif : levier plafonné à x5, jamais plus", () => {
  const p = perpsSizing(100, 100, 100, 99, AGGRESSIVE.maxRisk, AGGRESSIVE.maxLeverage)!;
  assert.ok(p.leverage <= 5 + 1e-9 && p.leverage > 3, JSON.stringify(p));
  const n = perpsSizing(100, 100, 100, 99, 0.015)!;
  assert.ok(n.leverage <= 3 + 1e-9);
});
test("backtest : longs seulement = aucun short", () => {
  let s = 3; const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
  const c: Candle[] = []; let p = 100;
  for (let i = 0; i < 2500; i++) { const n = p * Math.exp(Math.sin(i / 300) * 0.002 + (rnd() - 0.5) * 0.012); c.push({ t: i * 3_600_000, o: p, h: Math.max(p, n) * 1.003, l: Math.min(p, n) * 0.997, c: n }); p = n; }
  const both = backtest(c, { allowShort: true, feePct: 0.0012, leverageCap: 3 });
  const longOnly = backtest(c, { allowShort: true, feePct: 0.0012, leverageCap: 3, bias: 100 });
  const shortOnly = backtest(c, { allowShort: true, feePct: 0.0012, leverageCap: 3, bias: -100 });
  assert.ok(both.log.some((t) => t.side === "short") && both.log.some((t) => t.side === "long"), "données avec les deux côtés");
  assert.ok(longOnly.log.every((t) => t.side === "long")); assert.ok(shortOnly.log.every((t) => t.side === "short"));
  const agg = backtest(c, { allowShort: true, feePct: 0.0012, leverageCap: 5, risk: AGGRESSIVE.maxRisk });
  assert.ok(Math.abs(agg.returnPct) >= Math.abs(both.returnPct) * 0.9, "l'agressif amplifie gains et pertes");
});
