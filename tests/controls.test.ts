import { test } from "node:test";
import assert from "node:assert/strict";
import { AGGR_LEVELS, effectiveAggr, loadConfig, loadPerpsConfig, perpsSizing, stopSafeLeverage } from "../supabase/functions/pulse/engine/strategy.ts";
import { space, SPACE, tempo } from "../supabase/functions/pulse/engine/research.ts";

test("levier : seuls x3, x5, x10, x100, x250 sont acceptés", () => {
  assert.equal(loadPerpsConfig({ maxLev: 100 }).maxLev, 100); assert.equal(loadPerpsConfig({ maxLev: 500 }).maxLev, 3); assert.equal(loadPerpsConfig({ maxLev: 250 }).maxLev, 250);
});
test("garde-fou : le stop est toujours touché avant la liquidation, même à x250", () => {
  for (const dist of [0.003, 0.01, 0.02, 0.05]) {
    const s = perpsSizing(1000, 1000, 100, 100 * (1 - dist), 0.015, 250)!;
    const liqDist = 1 / s.leverage - 0.002; // perte qui déclenche la liquidation sur Jupiter
    assert.ok(dist * 3 <= liqDist + 1e-9, `liquidation au moins 3 fois plus loin que le stop : stop ${dist} vs liquidation ${liqDist.toFixed(4)} à x${s.leverage.toFixed(1)}`);
    assert.ok(Math.abs(s.notional * dist - 15) < 1e-6, "la perte au stop reste le risque choisi (1,5 % de 1000 $)");
  }
  assert.ok(stopSafeLeverage(0.02) < 17 && stopSafeLeverage(0.002) > 90);
});
test("plus de levier = moins de collatéral bloqué, même perte au stop", () => {
  const a = perpsSizing(1000, 1000, 100, 99, 0.015, 3)!, b = perpsSizing(1000, 1000, 100, 99, 0.015, 10)!;
  assert.equal(a.notional, b.notional); assert.ok(b.collateral < a.collateral);
});
test("agressivité : 5 niveaux, plafonnée à Normal en pilote automatique sauf mode agressif des agents", () => {
  assert.equal(AGGR_LEVELS.length, 5);
  assert.equal(effectiveAggr({ aggr: 4, autopilot: false, pilotAggressive: false }), 4);
  assert.equal(effectiveAggr({ aggr: 4, autopilot: true, pilotAggressive: false }), 1);
  assert.equal(effectiveAggr({ aggr: 4, autopilot: true, pilotAggressive: true }), 4);
  assert.equal(effectiveAggr({ aggr: 0, autopilot: true, pilotAggressive: false }), 0, "prudent reste prudent");
});
test("nervosité : réglages des agents bornés, normal par défaut", () => {
  assert.equal(loadConfig(null).nerve, 1); assert.equal(loadConfig({ nerve: 9 }).nerve, 3); assert.equal(loadConfig({ researchAggressive: true }).researchAggressive, true);
});
test("rythme des stratégies et espace de recherche nerveux", () => {
  assert.equal(tempo({ interval: "1h", family: "tendance", params: { breakout: 72 } }), 0);
  assert.equal(tempo({ interval: "1h", family: "tendance", params: { breakout: 24 } }), 1);
  assert.equal(tempo({ interval: "15m", family: "tendance", params: { breakout: 8 } }), 3);
  assert.equal(tempo({ interval: "15m", family: "rsi", params: { rsiPeriod: 14 } }), 2);
  assert.deepEqual(space(false), SPACE);
  const f = space(true);
  assert.deepEqual(f.tendance.breakout.slice(0, 3), [6, 8, 12]); assert.ok(f.rsi.rsiPeriod.includes(5));
  for (const l of Object.values(f.tendance)) assert.deepEqual([...l], [...l].sort((a, b) => a - b));
});
