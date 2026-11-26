import { test } from "node:test";
import assert from "node:assert/strict";
import { backtest, exitCheck, missionEnd, perpsSizing, spotSizeUsd, trailStop, trendSignal, type Candle } from "../supabase/functions/pulse/engine/strategy.ts";
import { choosePreset, learn, newBrain, riskPerTrade, isBenched } from "../supabase/functions/pulse/engine/brain.ts";

function series(n: number, f: (i: number) => number, noise = 0.004, seed = 1): Candle[] {
  let s = seed; const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
  const out: Candle[] = []; let prev = f(0);
  for (let i = 0; i < n; i++) { const c = f(i) * (1 + (rnd() - 0.5) * noise);
    out.push({ t: i * 3_600_000, o: prev, h: Math.max(prev, c) * (1 + rnd() * noise / 2), l: Math.min(prev, c) * (1 - rnd() * noise / 2), c }); prev = c; }
  return out;
}
const breakout = (c: Candle[], up: boolean) => { const l = c.at(-1)!; c.push({ t: c.length * 3_600_000, o: l.c, h: l.c * (up ? 1.03 : 1), l: l.c * (up ? 1 : 0.97), c: l.c * (up ? 1.025 : 0.975) }); return c; };

test("long sur cassure en tendance haussière", () => {
  const s = trendSignal(breakout(series(300, (i) => 100 * 1.002 ** i), true), true);
  assert.equal(s.side, "long"); assert.ok(s.stop < s.price);
});
test("short seulement si autorisé", () => {
  const c = breakout(series(300, (i) => 100 * 0.998 ** i), false);
  assert.equal(trendSignal(c, true).side, "short"); assert.equal(trendSignal(c, false).side, null);
});
test("aucun trade en marché sans tendance", () => {
  const r = backtest(series(2000, (i) => 100 * (1 + 0.02 * Math.sin(i / 9)), 0.012, 3), { allowShort: true, feePct: 0.001 });
  assert.ok(r.maxDrawdownPct < 15);
});
test("taille au risque", () => {
  assert.ok(Math.abs(spotSizeUsd(27, 27, 100, 97) - 13.5) < 0.01);
  const p = perpsSizing(27, 27, 100, 97)!; assert.ok(p.collateral >= 10 && p.leverage <= 3);
  assert.equal(perpsSizing(5, 5, 100, 97), null);
});
test("sorties", () => {
  assert.equal(exitCheck({ side: "long", entry: 100, price: 96, stop: 97, initialRisk: 3, openedAt: 0 }, 1), "stop_loss");
  assert.equal(exitCheck({ side: "long", entry: 100, price: 104, stop: 105, initialRisk: 3, openedAt: 0 }, 1), "trailing_stop");
  assert.equal(trailStop("long", 105, 106, 2), 105);
});
test("jamais de fin de mission sur données incomplètes", () => {
  assert.equal(missionEnd({ now: 0, endAt: 1, goalUsd: 5000, valueUsd: 0, floorUsd: 5, complete: false }), null);
});
test("cerveau : risque entre 0,5 % et 2 %, banc, choix du réglage", () => {
  const b = newBrain(100);
  for (let i = 0; i < 9; i++) learn(b, "SOL", -1.5, 100 - i, i);
  assert.ok(riskPerTrade(b) >= 0.005 - 1e-9); assert.ok(isBenched(b, "SOL", 20));
  const g = newBrain(100); for (let i = 0; i < 20; i++) learn(g, "JUP", i % 3 ? 3 : -1, 100 + i * 2, i);
  assert.ok(riskPerTrade(g) <= 0.02 + 1e-9);
  assert.equal(choosePreset({ a: { trades: 10, profitFactor: 0.9, returnPct: -5, maxDrawdownPct: 10 } as never }).name, null);
});
