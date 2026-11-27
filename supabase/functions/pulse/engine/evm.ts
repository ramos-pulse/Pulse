// Serveur uniquement : cryptographie « Ethereum » minimale pour signer les ordres Hyperliquid, sans dépendance externe.
//  - keccak-256 (le hachage d'Ethereum, différent de SHA3-256 par son remplissage)
//  - secp256k1 : clé publique, adresse, signature ECDSA déterministe (RFC 6979) avec numéro de récupération « v »
//  - msgpack : sérialisation des actions (même ordre des clés que le SDK Python officiel)
//  - EIP-712 : message typé « Agent » signé par Hyperliquid
// Vérifié contre les vecteurs de test du SDK Python officiel (tests/hyperliquid.test.ts).

// ---------------------------------------------------------------------------------------------------
// keccak-256
// ---------------------------------------------------------------------------------------------------
const RC = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n, 0x000000000000808bn, 0x0000000080000001n,
  0x8000000080008081n, 0x8000000000008009n, 0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n, 0x8000000000008002n, 0x8000000000000080n,
  0x000000000000800an, 0x800000008000000an, 0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];
const ROT = [0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14];
const M64 = (1n << 64n) - 1n;
const rotl = (x: bigint, n: number) => (n === 0 ? x : ((x << BigInt(n)) | (x >> BigInt(64 - n))) & M64);

function keccakF(s: bigint[]) {
  for (let round = 0; round < 24; round++) {
    const c = [0, 1, 2, 3, 4].map((x) => s[x]! ^ s[x + 5]! ^ s[x + 10]! ^ s[x + 15]! ^ s[x + 20]!);
    for (let x = 0; x < 5; x++) {
      const d = c[(x + 4) % 5]! ^ rotl(c[(x + 1) % 5]!, 1);
      for (let y = 0; y < 25; y += 5) s[y + x] = s[y + x]! ^ d;
    }
    const b = new Array<bigint>(25);
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) b[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(s[x + 5 * y]!, ROT[x + 5 * y]!);
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) s[x + 5 * y] = b[x + 5 * y]! ^ (~b[((x + 1) % 5) + 5 * y]! & M64 & b[((x + 2) % 5) + 5 * y]!);
    s[0] = s[0]! ^ RC[round]!;
  }
}

export function keccak256(data: Uint8Array): Uint8Array {
  const rate = 136, s = new Array<bigint>(25).fill(0n);
  const padded = new Uint8Array(Math.ceil((data.length + 1) / rate) * rate);
  padded.set(data);
  padded[data.length] = padded[data.length]! ^ 0x01; // remplissage Keccak (et non 0x06 comme SHA3)
  padded[padded.length - 1] = padded[padded.length - 1]! ^ 0x80;
  for (let off = 0; off < padded.length; off += rate) {
    for (let i = 0; i < rate / 8; i++) {
      let w = 0n;
      for (let k = 7; k >= 0; k--) w = (w << 8n) | BigInt(padded[off + i * 8 + k]!);
      s[i] = s[i]! ^ w;
    }
    keccakF(s);
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 4; i++) for (let k = 0; k < 8; k++) out[i * 8 + k] = Number((s[i]! >> BigInt(8 * k)) & 0xffn);
  return out;
}

// ---------------------------------------------------------------------------------------------------
// Utilitaires d'octets
// ---------------------------------------------------------------------------------------------------
export const hexToBytes = (h: string) => { const s = h.replace(/^0x/, ""); if (s.length % 2 || /[^0-9a-f]/i.test(s)) throw new Error("hexadécimal invalide"); return Uint8Array.from(s.match(/../g) ?? [], (b) => parseInt(b, 16)); };
export const bytesToHex = (b: Uint8Array) => "0x" + [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
const bytesToBig = (b: Uint8Array) => b.reduce((a, x) => (a << 8n) | BigInt(x), 0n);
const bigToBytes = (n: bigint, len = 32) => { const o = new Uint8Array(len); for (let i = len - 1; i >= 0; i--) { o[i] = Number(n & 0xffn); n >>= 8n; } return o; };
const concat = (...p: Uint8Array[]) => { const o = new Uint8Array(p.reduce((s, x) => s + x.length, 0)); let i = 0; for (const x of p) { o.set(x, i); i += x.length; } return o; };
const utf8 = (s: string) => new TextEncoder().encode(s);

// ---------------------------------------------------------------------------------------------------
// secp256k1
// ---------------------------------------------------------------------------------------------------
const P = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn;
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const G: Pt = [0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n, 0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n];
type Pt = [bigint, bigint] | null;
const mod = (a: bigint, m = P) => ((a % m) + m) % m;
function inv(a: bigint, m = P): bigint { // inverse modulaire (Euclide étendu)
  let [lo, hi, x0, x1] = [mod(a, m), m, 1n, 0n];
  while (lo > 1n) { const q = hi / lo; [lo, hi] = [hi - q * lo, lo]; [x0, x1] = [x1 - q * x0, x0]; }
  return mod(x0, m);
}
function add(a: Pt, b: Pt): Pt {
  if (!a) return b; if (!b) return a;
  if (a[0] === b[0] && mod(a[1] + b[1]) === 0n) return null;
  const l = a[0] === b[0] ? mod(3n * a[0] * a[0] * inv(2n * a[1])) : mod((b[1] - a[1]) * inv(b[0] - a[0]));
  const x = mod(l * l - a[0] - b[0]);
  return [x, mod(l * (a[0] - x) - a[1])];
}
function mul(k: bigint, p: Pt): Pt { let r: Pt = null, q = p; while (k > 0n) { if (k & 1n) r = add(r, q); q = add(q, q); k >>= 1n; } return r; }

/** Signature RFC 6979 (k déterministe, HMAC-SHA256) — identique à eth_account pour une même clé et un même message. */
async function hmac(key: Uint8Array, ...msg: Uint8Array[]) {
  const k = await crypto.subtle.importKey("raw", new Uint8Array(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, new Uint8Array(concat(...msg))));
}
async function rfc6979(priv: bigint, h: Uint8Array): Promise<bigint> {
  const x = bigToBytes(priv), hm = bigToBytes(mod(bytesToBig(h), N));
  let v = new Uint8Array(32).fill(1), k = new Uint8Array(32);
  k = await hmac(k, v, new Uint8Array([0]), x, hm); v = await hmac(k, v);
  k = await hmac(k, v, new Uint8Array([1]), x, hm); v = await hmac(k, v);
  for (;;) {
    v = await hmac(k, v);
    const t = bytesToBig(v);
    if (t > 0n && t < N) return t;
    k = await hmac(k, v, new Uint8Array([0])); v = await hmac(k, v);
  }
}

export interface Signature { r: string; s: string; v: number }
/** Signe un hachage de 32 octets : r, s (s « bas », comme Ethereum) et v = 27/28. Format de sortie identique au SDK officiel. */
export async function signHash(privHex: string, hash: Uint8Array): Promise<Signature> {
  const d = bytesToBig(hexToBytes(privHex));
  if (!(d > 0n && d < N)) throw new Error("clé privée invalide");
  const z = mod(bytesToBig(hash), N);
  for (let attempt = 0; ; attempt++) {
    const k = await rfc6979(d, attempt ? keccak256(concat(hash, new Uint8Array([attempt]))) : hash);
    const R = mul(k, G)!;
    const r = mod(R[0], N);
    if (r === 0n) continue;
    let s = mod(inv(k, N) * (z + r * d), N);
    if (s === 0n) continue;
    let rec = Number(R[1] & 1n) | (R[0] >= N ? 2 : 0);
    if (s > N / 2n) { s = N - s; rec ^= 1; } // s bas (EIP-2)
    return { r: "0x" + r.toString(16), s: "0x" + s.toString(16), v: 27 + rec };
  }
}

/** Adresse Ethereum (minuscules) d'une clé privée. */
export function addressOf(privHex: string): string {
  const pub = mul(bytesToBig(hexToBytes(privHex)), G)!;
  return bytesToHex(keccak256(concat(bigToBytes(pub[0]), bigToBytes(pub[1]))).slice(12));
}

/** Retrouve l'adresse qui a signé (pour vérifier nos propres signatures avant envoi). */
export function recoverAddress(hash: Uint8Array, sig: Signature): string {
  const r = BigInt(sig.r), s = BigInt(sig.s), rec = sig.v - 27;
  const x = r + (rec & 2 ? N : 0n);
  const y2 = mod(x * x * x + 7n), yy = powMod(y2, (P + 1n) / 4n);
  const y = (yy & 1n) === BigInt(rec & 1) ? yy : P - yy;
  const z = mod(bytesToBig(hash), N), ri = inv(r, N);
  const Q = add(mul(mod(-z * ri, N), G), mul(mod(s * ri, N), [x, y]))!;
  return bytesToHex(keccak256(concat(bigToBytes(Q[0]), bigToBytes(Q[1]))).slice(12));
}
function powMod(b: bigint, e: bigint): bigint { let r = 1n; b = mod(b); while (e > 0n) { if (e & 1n) r = mod(r * b); b = mod(b * b); e >>= 1n; } return r; }

// ---------------------------------------------------------------------------------------------------
// msgpack (sous-ensemble utilisé par Hyperliquid : nil, booléens, entiers, chaînes, octets, tableaux, objets)
// ---------------------------------------------------------------------------------------------------
export function msgpack(v: unknown): Uint8Array {
  const out: number[] = [];
  const u = (n: number, bytes: number) => { for (let i = bytes - 1; i >= 0; i--) out.push(Math.floor(n / 2 ** (8 * i)) & 0xff); };
  const big = (n: bigint, bytes: number) => { for (let i = bytes - 1; i >= 0; i--) out.push(Number((n >> BigInt(8 * i)) & 0xffn)); };
  const enc = (x: unknown): void => {
    if (x === null || x === undefined) { out.push(0xc0); return; }
    if (x === true) { out.push(0xc3); return; }
    if (x === false) { out.push(0xc2); return; }
    if (typeof x === "bigint" || (typeof x === "number" && Number.isInteger(x))) {
      const n = BigInt(x);
      if (n >= 0n) {
        if (n < 128n) out.push(Number(n));
        else if (n < 256n) { out.push(0xcc); big(n, 1); }
        else if (n < 65536n) { out.push(0xcd); big(n, 2); }
        else if (n < 4294967296n) { out.push(0xce); big(n, 4); }
        else { out.push(0xcf); big(n, 8); }
      } else {
        if (n >= -32n) out.push(Number(n & 0xffn));
        else if (n >= -128n) { out.push(0xd0); big(n & 0xffn, 1); }
        else if (n >= -32768n) { out.push(0xd1); big(n & 0xffffn, 2); }
        else if (n >= -2147483648n) { out.push(0xd2); big(n & 0xffffffffn, 4); }
        else { out.push(0xd3); big(n & M64, 8); }
      }
      return;
    }
    if (typeof x === "number") { out.push(0xcb); const b = new DataView(new ArrayBuffer(8)); b.setFloat64(0, x); for (let i = 0; i < 8; i++) out.push(b.getUint8(i)); return; }
    if (typeof x === "string") {
      const b = utf8(x), n = b.length;
      if (n < 32) out.push(0xa0 | n); else if (n < 256) { out.push(0xd9); u(n, 1); } else if (n < 65536) { out.push(0xda); u(n, 2); } else { out.push(0xdb); u(n, 4); }
      out.push(...b); return;
    }
    if (x instanceof Uint8Array) { const n = x.length; if (n < 256) { out.push(0xc4); u(n, 1); } else if (n < 65536) { out.push(0xc5); u(n, 2); } else { out.push(0xc6); u(n, 4); } out.push(...x); return; }
    if (Array.isArray(x)) { const n = x.length; if (n < 16) out.push(0x90 | n); else if (n < 65536) { out.push(0xdc); u(n, 2); } else { out.push(0xdd); u(n, 4); } x.forEach(enc); return; }
    if (typeof x === "object") {
      const e = Object.entries(x as Record<string, unknown>).filter(([, val]) => val !== undefined);
      const n = e.length; if (n < 16) out.push(0x80 | n); else if (n < 65536) { out.push(0xde); u(n, 2); } else { out.push(0xdf); u(n, 4); }
      for (const [k, val] of e) { enc(k); enc(val); }
      return;
    }
    throw new Error(`msgpack : type non géré (${typeof x})`);
  };
  enc(v);
  return Uint8Array.from(out);
}

// ---------------------------------------------------------------------------------------------------
// Signature des actions Hyperliquid (« L1 action » : message EIP-712 Agent{source, connectionId})
// ---------------------------------------------------------------------------------------------------
/** Hachage d'une action : msgpack(action) + nonce (8 octets) + coffre (aucun ici) [+ expiresAfter]. */
export function actionHash(action: unknown, nonce: number, vault: string | null = null, expiresAfter: number | null = null): Uint8Array {
  const parts = [msgpack(action), bigToBytes(BigInt(nonce), 8)];
  if (vault) parts.push(new Uint8Array([1]), hexToBytes(vault)); else parts.push(new Uint8Array([0]));
  if (expiresAfter != null) parts.push(new Uint8Array([0]), bigToBytes(BigInt(expiresAfter), 8));
  return keccak256(concat(...parts));
}

const typeHash = (s: string) => keccak256(utf8(s));
const DOMAIN_SEP = keccak256(concat(
  typeHash("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
  keccak256(utf8("Exchange")), keccak256(utf8("1")), bigToBytes(1337n), new Uint8Array(32),
));
const AGENT_TYPE = typeHash("Agent(string source,bytes32 connectionId)");

/** Hachage EIP-712 final à signer pour une action (mainnet : source « a », testnet : « b »). */
export function l1Digest(action: unknown, nonce: number, mainnet = true, vault: string | null = null, expiresAfter: number | null = null): Uint8Array {
  const conn = actionHash(action, nonce, vault, expiresAfter);
  const struct = keccak256(concat(AGENT_TYPE, keccak256(utf8(mainnet ? "a" : "b")), conn));
  return keccak256(concat(new Uint8Array([0x19, 0x01]), DOMAIN_SEP, struct));
}

export async function signL1Action(privHex: string, action: unknown, nonce: number, mainnet = true, vault: string | null = null, expiresAfter: number | null = null) {
  return signHash(privHex, l1Digest(action, nonce, mainnet, vault, expiresAfter));
}
