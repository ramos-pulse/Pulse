// Agents on-chain : filtres du sélectionneur, garde-fous de l'agent nouveaux tokens, mise, arbitrage éclaireur.
import { test } from "node:test";
import assert from "node:assert/strict";
import { dexSpread, freshRefusal, freshStake, rankSelection, selectionRefusal, type JupToken } from "../supabase/functions/pulse/engine/agents.ts";

const TP = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const safe = (x: Partial<JupToken> = {}): JupToken => ({ id: "M", symbol: "OK", decimals: 6, tokenProgram: TP, isVerified: true, audit: { mintAuthorityDisabled: true, freezeAuthorityDisabled: true, topHoldersPercentage: 10 }, ...x });
const cand = { mint: "M", symbol: "OK", decimals: 6, pool: "P", liquidity: 2e6, volume24h: 3e6, ageDays: 90 };

test("sélectionneur : filtres stricts (liquidité, volume, vérifié, âge, émission et gel désactivés)", () => {
  assert.equal(selectionRefusal(cand, safe()), null);
  assert.match(selectionRefusal(cand, safe({ isVerified: false }))!, /non vérifié/);
  assert.match(selectionRefusal(cand, safe({ audit: { mintAuthorityDisabled: false, freezeAuthorityDisabled: true } }))!, /émission/);
  assert.match(selectionRefusal(cand, safe({ audit: { mintAuthorityDisabled: true, freezeAuthorityDisabled: false } }))!, /gel/);
  assert.match(selectionRefusal({ ...cand, liquidity: 5e5 }, safe())!, /liquidité/);
  assert.match(selectionRefusal({ ...cand, volume24h: 2e5 }, safe())!, /volume/);
  assert.match(selectionRefusal({ ...cand, ageDays: 10 }, safe())!, /récent/);
  assert.equal(selectionRefusal(cand, safe({ tokenProgram: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" })), null); // Token-2022 accepté (extensions vérifiées ensuite)
  assert.match(selectionRefusal(cand, safe({ tokenProgram: "AutreProgramme1111111111111111111111111111" }))!, /inconnu/);
  const many = Array.from({ length: 40 }, (_, i) => ({ ...cand, mint: "M" + i, volume24h: 1e6 + i * 1e5 }));
  const info = new Map(many.map((c) => [c.mint, safe({ id: c.mint })]));
  const r = rankSelection(many, info);
  assert.equal(r.selected.length, 25); assert.equal(r.selected[0]!.mint, "M39", "les plus échangés d'abord");
});

test("nouveaux tokens : garde-fous anti-arnaque", () => {
  const f = { mint: "N", symbol: "NEW", decimals: 6, pool: "P", liquidity: 1e5, volume1h: 5e4, change1h: 15, buys1h: 200, sells1h: 120, ageMin: 180 };
  assert.equal(freshRefusal(f, safe({ isVerified: false })), null, "un nouveau token n'a pas besoin d'être vérifié, mais doit passer le reste");
  assert.match(freshRefusal(f, safe({ audit: { mintAuthorityDisabled: true, freezeAuthorityDisabled: false, topHoldersPercentage: 5 } }))!, /gel/);
  assert.match(freshRefusal(f, safe({ audit: { mintAuthorityDisabled: true, freezeAuthorityDisabled: true, topHoldersPercentage: 60 } }))!, /concentration/);
  assert.match(freshRefusal({ ...f, sells1h: 3 }, safe())!, /vente/);
  assert.match(freshRefusal({ ...f, ageMin: 10 }, safe())!, /trop jeune/);
  assert.match(freshRefusal({ ...f, change1h: 300 }, safe())!, /variation/);
  assert.match(freshRefusal({ ...f, liquidity: 2e4 }, safe())!, /liquidité/);
  assert.match(freshRefusal({ ...f, buys1h: 100, sells1h: 150 }, safe())!, /vendeurs/);
  // mise : 5 % du capital entre 2 et 5 $, jamais plus de 20 % du capital
  assert.equal(freshStake(100), 5); assert.equal(freshStake(40), 2); assert.equal(freshStake(10), 2); assert.equal(freshStake(8), 0);
});

test("arbitrage éclaireur : écart entre DEX, frais déduits", () => {
  const pair = (dex: string, p: number, liq = 1e6) => ({ dexId: dex, pairAddress: dex, baseToken: { address: "M", symbol: "X" }, quoteToken: { address: "U", symbol: "USDC" }, priceUsd: String(p), liquidity: { usd: liq } });
  const o = dexSpread("X", [pair("orca", 1), pair("raydium", 1.01), pair("petit", 1.5, 1000)], "M")!;
  assert.ok(Math.abs(o.grossPct - 1) < 1e-9, "le pool trop petit est ignoré");
  assert.ok(o.netPct < o.grossPct - 0.5, "frais de 2 swaps et de réseau déduits");
  assert.equal(dexSpread("X", [pair("orca", 1)], "M"), null);
});

test("mode extra souple : nouveaux tokens moins exigeants, mais les contrôles anti-arnaque restent", () => {
  const f = { mint: "N", symbol: "NEW", decimals: 6, pool: "P", liquidity: 3e4, volume1h: 1.2e4, change1h: 80, buys1h: 50, sells1h: 60, ageMin: 120 };
  assert.ok(freshRefusal(f, safe()) !== null, "refusé en mode normal");
  assert.equal(freshRefusal(f, safe(), true), null, "accepté en extra souple");
  assert.match(freshRefusal(f, safe({ audit: { mintAuthorityDisabled: true, freezeAuthorityDisabled: false, topHoldersPercentage: 5 } }), true)!, /gel/);
  assert.match(freshRefusal({ ...f, sells1h: 4 }, safe(), true)!, /vente/);
});
