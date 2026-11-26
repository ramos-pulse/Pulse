import { test } from "node:test";
import assert from "node:assert/strict";
import { backtestRsi, loadConfig, rsiExitSignal, rsiSeries, rsiSignal, RSI_DEFAULTS, sanitizeRsi, smaSeries, type Candle } from "../supabase/functions/pulse/engine/strategy.ts";

const mk = (closes: number[]): Candle[] => closes.map((c, i) => ({ t: i * 3_600_000, o: i ? closes[i - 1]! : c, h: c * 1.002, l: c * 0.998, c }));
// tendance haussière longue, puis 4 baisses brutales (RSI qui plonge sous 30) en restant au-dessus de la MM200
function dipInUptrend(): number[] {
  const up = Array.from({ length: 260 }, (_, i) => 100 * 1.003 ** i);
  const top = up.at(-1)!;
  return [...up, ...Array.from({ length: 8 }, (_, k) => top * 0.985 ** (k + 1))];
}

test("RSI : bornes et cas plat", () => {
  const r = rsiSeries(Array.from({ length: 60 }, (_, i) => 100 + i), 14);
  assert.ok(Number.isNaN(r[5]!)); assert.equal(r.at(-1), 100);
  assert.equal(smaSeries([1, 2, 3, 4], 2).at(-1), 3.5);
});
test("achat quand le RSI passe sous 30 au-dessus de la MM200", () => {
  const c = mk(dipInUptrend());
  // trouve la bougie où le RSI croise 30 vers le bas
  const r = rsiSeries(c.map((x) => x.c), 14);
  const i = r.findIndex((v, k) => k > 0 && r[k - 1]! >= 30 && v < 30);
  assert.ok(i > 0, "le RSI doit croiser 30");
  const sig = rsiSignal(c.slice(0, i + 1), RSI_DEFAULTS);
  assert.equal(sig.side, "long", sig.reason);
  const lows = c.slice(i - 9, i + 1).map((x) => x.l);
  assert.equal(sig.stop, Math.min(...lows), "stop = plus bas des 10 dernières bougies");
});
test("pas d'achat sous la MM200, mais oui en mode naïf", () => {
  const down = Array.from({ length: 260 }, (_, i) => 100 * 0.998 ** i);
  const bot = down.at(-1)!;
  const c = mk([...down, bot * 0.985, bot * 0.97]);
  const r = rsiSeries(c.map((x) => x.c), 14);
  assert.ok(r.at(-1)! < 30);
  assert.equal(rsiSignal(c, RSI_DEFAULTS).side, null);
  assert.equal(rsiSignal(c, { ...RSI_DEFAULTS, naive: true }).side, "long");
});
test("sortie quand le RSI repasse au-dessus de 50 (70 en naïf)", () => {
  const c = mk([...dipInUptrend(), ...Array.from({ length: 8 }, (_, i) => 100 * 1.003 ** 259 * (0.96 + i * 0.01))]);
  assert.equal(rsiExitSignal(c, RSI_DEFAULTS).exit, true);
});
test("réglages bornés et valeurs par défaut", () => {
  const p = sanitizeRsi({ rsiPeriod: 999, entry: 60, exit: 10, riskPct: 50, naive: "oui" as never });
  assert.equal(p.rsiPeriod, 50); assert.equal(p.entry, 50); assert.ok(p.exit > p.entry); assert.equal(p.riskPct, 3); assert.equal(p.naive, false);
  assert.deepEqual(loadConfig(null), { strategy: "tendance", rsi: RSI_DEFAULTS });
});
test("backtest RSI : une position à la fois, risque ≈ 1 % par perte", () => {
  let s = 7; const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
  const closes = [100]; for (let i = 1; i < 3000; i++) closes.push(closes[i - 1]! * (1 + (rnd() - 0.49) * 0.02));
  const r = backtestRsi(mk(closes), RSI_DEFAULTS, 0.003);
  const nv = backtestRsi(mk(closes), { ...RSI_DEFAULTS, naive: true }, 0.003);
  assert.ok(r.trades > 0 && nv.trades > 0);
  for (const t of r.log) if (t.reason === "stop_loss") assert.ok(t.pnlPct > -2.5, `perte trop grosse ${t.pnlPct}`);
  console.log(`   filtre MM200 : ${r.trades} trades, PF ${r.profitFactor.toFixed(2)} | naïf : ${nv.trades} trades, PF ${nv.profitFactor.toFixed(2)}`);
});
