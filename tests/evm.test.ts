// Cryptographie Hyperliquid : vecteurs de test officiels (SDK Python hyperliquid-dex, tests/signing_test.py).
import { test } from "node:test";
import assert from "node:assert/strict";
import { actionHash, addressOf, bytesToHex, keccak256, msgpack, recoverAddress, signL1Action, l1Digest } from "../supabase/functions/pulse/engine/evm.ts";

const KEY = "0x0123456789012345678901234567890123456789012345678901234567890123";

test("keccak-256 : vecteurs connus", () => {
  assert.equal(bytesToHex(keccak256(new Uint8Array())), "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470");
  assert.equal(bytesToHex(keccak256(new TextEncoder().encode("abc"))), "0x4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45");
  const long = new Uint8Array(300).fill(0x61); // plusieurs blocs
  assert.equal(keccak256(long).length, 32);
});

test("secp256k1 : adresse d'une clé connue", () => {
  assert.equal(addressOf("0x0000000000000000000000000000000000000000000000000000000000000001"), "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf");
});

test("msgpack : encodage identique au SDK (ordre des clés, entiers)", () => {
  assert.equal(bytesToHex(msgpack({ a: 1, b: true, c: "x" })), "0x83a16101a162c3a163a178");
  assert.equal(bytesToHex(msgpack(100000000000)), "0xcf000000174876e800");
  assert.equal(bytesToHex(msgpack([])), "0x90");
});

test("Hyperliquid : agent fantôme d'un ordre (production)", () => {
  const action = { type: "order", orders: [{ a: 4, b: true, p: "1670.1", s: "0.0147", r: false, t: { limit: { tif: "Ioc" } } }], grouping: "na" };
  assert.equal(bytesToHex(actionHash(action, 1677777606040)), "0x0fcbeda5ae3c4950a548021552a4fea2226858c4453571bf3f24ba017eac2908");
});

test("Hyperliquid : signature d'une action (mainnet et testnet)", async () => {
  const action = { type: "dummy", num: 100000000000 };
  const m = await signL1Action(KEY, action, 0, true);
  assert.deepEqual(m, { r: "0x53749d5b30552aeb2fca34b530185976545bb22d0b3ce6f62e31be961a59298", s: "0x755c40ba9bf05223521753995abb2f73ab3229be8ec921f350cb447e384d8ed8", v: 27 });
  const t = await signL1Action(KEY, action, 0, false);
  assert.deepEqual(t, { r: "0x542af61ef1f429707e3c76c5293c80d01f74ef853e34b76efffcb57e574f9510", s: "0x17b8b32f086e8cdede991f1e2c529f5dd5297cbe8128500e00cbaf766204a613", v: 28 });
});

test("Hyperliquid : signature d'un ordre", async () => {
  const action = { type: "order", orders: [{ a: 1, b: true, p: "100", s: "100", r: false, t: { limit: { tif: "Gtc" } } }], grouping: "na" };
  const m = await signL1Action(KEY, action, 0, true);
  assert.deepEqual(m, { r: "0xd65369825a9df5d80099e513cce430311d7d26ddf477f5b3a33d2806b100d78e", s: "0x2b54116ff64054968aa237c20ca9ff68000f977c93289157748a3162b6ea940e", v: 28 });
  const t = await signL1Action(KEY, action, 0, false);
  assert.deepEqual(t, { r: "0x82b2ba28e76b3d761093aaded1b1cdad4960b3af30212b343fb2e6cdfa4e3d54", s: "0x6b53878fc99d26047f4d7e8c90eb98955a109f44209163f52d8dc4278cbbd9f5", v: 27 });
});

test("Hyperliquid : signature avec coffre et récupération du signataire", async () => {
  const action = { type: "dummy", num: 100000000000 };
  const m = await signL1Action(KEY, action, 0, true, "0x1719884eb866cb12b2287399b15f7db5e7d775ea");
  assert.equal(m.r, "0x3c548db75e479f8012acf3000ca3a6b05606bc2ec0c29c50c515066a326239");
  assert.equal(m.v, 28);
  assert.equal(recoverAddress(l1Digest(action, 0, true, "0x1719884eb866cb12b2287399b15f7db5e7d775ea"), m), addressOf(KEY));
});
