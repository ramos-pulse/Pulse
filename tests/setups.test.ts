// Nouvelles familles (ORB, VWAP, compression, volume, funding), seuils par unité de temps, backtest identique au réel, protections.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  backtest, exitCheck, exitSlippageBps, floorOf, groupOf, perpsSizing, solReserveAlert, stopSafeLeverage, trendSignal, volScale, cooldownMs, activeHour,
  type Candle, type Memory,
} from "../supabase/functions/pulse/engine/strategy.ts";
import { backtestSetup, fundingAt, sessionStart, setupExit, setupSignal, sanitizeSetup } from "../supabase/functions/pulse/engine/setups.ts";

const H = 3_600_000, Q = 900_000;
/** Bougies régulières à partir d'une liste de prix de clôture. */
function fromCloses(closes: number[], step: number, t0: number, spread = 0.001, vol = 100): Candle[] {
  return closes.map((c, i) => { const o = i ? closes[i - 1]! : c; return { t: t0 + i * step, o, h: Math.max(o, c) * (1 + spread), l: Math.min(o, c) * (1 - spread), c, v: vol }; });
}
let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;

test("seuils adaptés au 15 min : une volatilité de 0,3 % n'est plus « trop calme »", () => {
  // tendance haussière régulière en 15 min avec ATR ≈ 0,3 % (bloqué avant : seuil 0,4 % pour toutes les unités de temps)
  const closes: number[] = []; let p = 100;
  for (let i = 0; i < 420; i++) { p *= 1 + 0.0006 + (rnd() - 0.5) * 0.002; closes.push(p); }
  closes.push(p * 1.01); // cassure
  const c = fromCloses(closes, Q, Date.UTC(2026, 10, 2), 0.0012);
  const sig = trendSignal(c, false, { breakout: 24, trailAtr: 2, minTrend: 0.3 });
  assert.ok(!/trop calme/.test(sig.reason), sig.reason);
  assert.equal(cooldownMs("15m"), 15 * 60_000);
  assert.equal(cooldownMs("1h"), 60 * 60_000);
  // sortie d'une position qui stagne : 24 h en 15 min, 96 h en 1 h
  const base = { side: "long" as const, entry: 100, price: 100.1, stop: 98, initialRisk: 2, openedAt: 0 };
  assert.equal(exitCheck({ ...base, interval: "15m" }, 25 * H), "time_stop");
  assert.equal(exitCheck({ ...base, interval: "1h" }, 25 * H), null);
});

test("heures d'ouverture : Wall Street suit l'heure d'été américaine, pas de séance le week-end", () => {
  const winter = sessionStart("us", Date.UTC(2026, 10, 27, 20)); // vendredi 27/11/2026
  assert.equal(new Date(winter!).toISOString(), "2026-11-27T14:30:00.000Z"); // 15 h 30 à Paris
  const summer = sessionStart("us", Date.UTC(2026, 6, 1, 20));
  assert.equal(new Date(summer!).toISOString(), "2026-07-01T13:30:00.000Z");
  assert.equal(new Date(sessionStart("eu", Date.UTC(2026, 6, 1, 12))!).toISOString(), "2026-07-01T07:00:00.000Z");
  assert.equal(new Date(sessionStart("eu", Date.UTC(2026, 11, 1, 12))!).toISOString(), "2026-12-01T08:00:00.000Z");
  // samedi : la dernière séance américaine est celle du vendredi
  assert.equal(new Date(sessionStart("us", Date.UTC(2026, 10, 28, 20))!).toISOString(), "2026-11-27T14:30:00.000Z");
  assert.ok(activeHour(Date.UTC(2026, 10, 27, 10)) && !activeHour(Date.UTC(2026, 10, 28, 10)) && !activeHour(Date.UTC(2026, 10, 27, 23)));
});

/** 300 bougies de 15 min avant la séance, puis la zone d'ouverture, puis une cassure haussière. */
function orbDay(): Candle[] {
  const open = Date.UTC(2026, 10, 27, 14, 30);
  const before: number[] = []; let p = 100;
  for (let i = 0; i < 300; i++) { p *= 1 + (rnd() - 0.5) * 0.004; before.push(p); }
  const c = fromCloses(before, Q, open - 300 * Q, 0.0015);
  const z = c.at(-1)!.c;
  c.push({ t: open, o: z, h: z * 1.004, l: z * 0.997, c: z * 1.001, v: 300 }, { t: open + Q, o: z * 1.001, h: z * 1.003, l: z * 0.998, c: z * 1.0, v: 250 });
  c.push({ t: open + 2 * Q, o: z, h: z * 1.002, l: z * 0.999, c: z * 1.001, v: 200 });
  c.push({ t: open + 3 * Q, o: z * 1.001, h: z * 1.008, l: z * 1.0, c: z * 1.007, v: 400 }); // cassure au-dessus de 1,004
  return c;
}
test("ORB : cassure de la zone des 30 premières minutes de Wall Street → achat, stop de l'autre côté, objectif 2 × la zone", () => {
  const c = orbDay(), z = c.at(-4)!.o;
  const P = sanitizeSetup("orb", { session: "us", zoneMin: 30, target: 2, window: 4 })!;
  const sig = setupSignal("orb", c, true, P);
  assert.equal(sig.side, "long", sig.reason);
  const hi = z * 1.004, lo = z * 0.997;
  assert.ok(Math.abs(sig.stop - lo) < 1e-9, "stop sous la zone");
  assert.ok(Math.abs(sig.target! - (sig.price + 2 * (hi - lo))) < 1e-9, "objectif = 2 × la zone");
  // une 2e cassure le même jour n'est pas reprise (seulement la première)
  const again = [...c, { ...c.at(-1)!, t: c.at(-1)!.t + Q }];
  assert.equal(setupSignal("orb", again, true, P).side, null);
  // sortie au bout de 2 × la fenêtre
  assert.equal(setupExit("orb", c, "long", P, 32, c.at(-1)!.t), "orb_temps");
  assert.equal(setupExit("orb", c, "long", P, 4, c.at(-1)!.t), null);
});

test("VWAP : prix très en dessous du prix moyen du jour, marché sans tendance → achat, objectif le VWAP", () => {
  const closes: number[] = []; let p = 100;
  for (let i = 0; i < 400; i++) { p = 100 + Math.sin(i / 6) * 0.5 + (rnd() - 0.5) * 0.2; closes.push(p); }
  const day = Date.UTC(2026, 10, 27);
  const c = fromCloses(closes, Q, day - 380 * Q, 0.001);
  const last = c.at(-1)!; c[c.length - 1] = { ...last, c: 97.5, l: 97.4 }; // décrochage brutal
  const sig = setupSignal("vwap", c, true, { dev: 2, stopAtr: 1.5, maxTrend: 3 });
  assert.equal(sig.side, "long", sig.reason);
  assert.ok(sig.target! > sig.price && sig.stop < sig.price);
  assert.equal(setupSignal("vwap", c, true, { dev: 50, stopAtr: 1.5, maxTrend: 3 }).side, null);
});

test("compression : bandes très resserrées puis cassure → entrée dans le sens de l'explosion", () => {
  const closes: number[] = []; let p = 100;
  for (let i = 0; i < 300; i++) { p = 100 + (rnd() - 0.5) * (i < 200 ? 3 : 0.3); closes.push(p); } // la volatilité retombe
  closes.push(102.5);
  const c = fromCloses(closes, H, Date.UTC(2026, 9, 1), 0.001);
  const sig = setupSignal("squeeze", c, true, { bbPeriod: 20, bbK: 2, lookback: 200, pct: 0.2, trailAtr: 2 });
  assert.equal(sig.side, "long", sig.reason);
  const down = [...closes.slice(0, -1), 97.5];
  assert.equal(setupSignal("squeeze", fromCloses(down, H, Date.UTC(2026, 9, 1), 0.001), true, { bbPeriod: 20, bbK: 2, lookback: 200, pct: 0.2, trailAtr: 2 }).side, "short");
});

test("momentum de volume : volume ×3 et forte bougie haussière → achat ; sans données de volume → rien", () => {
  const closes: number[] = []; let p = 100;
  for (let i = 0; i < 260; i++) { p *= 1 + (rnd() - 0.5) * 0.004; closes.push(p); }
  const c = fromCloses(closes, H, Date.UTC(2026, 9, 1), 0.001);
  const l = c.at(-1)!; c[c.length - 1] = { ...l, o: l.o, c: l.o * 1.012, h: l.o * 1.013, l: l.o * 0.999, v: 400 };
  assert.equal(setupSignal("volume", c, true, { volMult: 3, body: 0.8, trailAtr: 2 }).side, "long");
  assert.equal(setupSignal("volume", c.map((x) => ({ ...x, v: 0 })), true, { volMult: 3, body: 0.8, trailAtr: 2 }).side, null);
});

test("funding extrême : la foule massivement à l'achat + le prix cède → short ; données manquantes → rien", () => {
  const closes: number[] = []; let p = 100;
  for (let i = 0; i < 260; i++) { p *= 1 + (rnd() - 0.5) * 0.004; closes.push(p); }
  closes.push(p * 0.985);
  const c = fromCloses(closes, H, Date.UTC(2026, 9, 1), 0.001);
  const end = c.at(-1)!.t + H;
  const funding = Array.from({ length: 24 }, (_, k) => ({ t: end - (23 - k) * H, r: 0.0001 }));
  assert.ok(Math.abs(fundingAt(funding, end)! - 0.0001) < 1e-12);
  const P = { level: 0.00004, stopAtr: 2, hold: 16 };
  assert.equal(setupSignal("funding", c, true, P, { funding }).side, "short");
  assert.equal(setupSignal("funding", c, true, P, {}).side, null);
  assert.equal(setupSignal("funding", c, false, P, { funding }).side, null, "pas de short en spot");
});

test("backtest identique au réel : prise partielle, filtre BTC, frais ; les nouvelles familles se simulent", () => {
  const closes: number[] = []; let p = 100;
  for (let i = 0; i < 2000; i++) { p *= 1 + Math.sin(i / 120) * 0.0015 + (rnd() - 0.5) * 0.012; closes.push(p); }
  const c = fromCloses(closes, H, Date.UTC(2026, 6, 1), 0.002, 100);
  const o = { allowShort: true, feePct: 0.0012, hourlyCost: 0.00008, leverageCap: 3 };
  const plain = backtest(c, { ...o, noVolScale: true }), half = backtest(c, { ...o, partial: "half", noVolScale: true });
  assert.ok(plain.trades > 3, `${plain.trades} trades`);
  assert.ok(half.log.some((t) => t.reason === "prise_partielle"), "la moitié est vendue à +1,5 R comme en réel");
  assert.equal(backtest(c, { ...o, blockedAt: () => true }).trades, 0, "filtre BTC permanent : aucune entrée");
  for (const [f, P] of [["squeeze", { bbPeriod: 20, bbK: 2, lookback: 100, pct: 0.2, trailAtr: 2 }], ["vwap", { dev: 2, stopAtr: 1.5, maxTrend: 3 }], ["volume", { volMult: 1.5, body: 0.3, trailAtr: 2 }]] as const) {
    const r = backtestSetup(f, c, P, o);
    assert.ok(Number.isFinite(r.returnPct) && r.maxDrawdownPct >= 0, f);
    assert.ok(r.log.every((t) => Number.isFinite(t.pnlPct)), f);
  }
});

test("protections : liquidation 3× plus loin que le stop, seuil d'arrêt relatif, réserve de SOL, groupes de tokens, slippage", () => {
  for (const dist of [0.004, 0.01, 0.03]) {
    const s = perpsSizing(100, 100, 100, 100 * (1 - dist), 0.01, 250)!;
    assert.ok(3 * dist <= 1 / s.leverage - 0.002 + 1e-9, `x${s.leverage.toFixed(1)} pour un stop à ${dist}`);
  }
  assert.ok(stopSafeLeverage(0.01) < 30);
  assert.equal(floorOf(10, 5), 3);          // 30 % de 10 $
  assert.equal(floorOf(2, 5), 1);           // jamais sous 1 $
  assert.equal(floorOf(null, 5), 5);        // départ inconnu : ancien seuil
  const mem: Memory = { v: 3 };
  assert.ok(solReserveAlert(mem, 0.004, Date.UTC(2026, 10, 27, 8), "Bot spot"));
  assert.equal(solReserveAlert(mem, 0.004, Date.UTC(2026, 10, 27, 9), "Bot spot"), null, "une alerte par jour");
  assert.equal(solReserveAlert(mem, 0.05, Date.UTC(2026, 10, 28, 9), "Bot spot"), null);
  assert.equal(groupOf("BONK"), groupOf("WIF")); assert.notEqual(groupOf("SOL"), groupOf("BONK"));
  assert.equal(exitSlippageBps(0.0001), 53);  // token liquide : 0,5 % de marge environ
  assert.equal(exitSlippageBps(0.01), 150);   // gros impact : plafond 1,5 %
});

test("taille selon la volatilité : risque réduit quand le marché s'agite", () => {
  const closes: number[] = []; let p = 100;
  for (let i = 0; i < 260; i++) { p *= 1 + (rnd() - 0.5) * (i < 240 ? 0.004 : 0.03); closes.push(p); }
  assert.ok(volScale(fromCloses(closes, H, 0, 0.001)) < 1);
  assert.equal(volScale(fromCloses(closes.slice(0, 240), H, 0, 0.001)), 1);
});
