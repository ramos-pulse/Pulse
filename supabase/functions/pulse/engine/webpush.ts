// Notifications push sur le téléphone (Web Push, RFC 8291 + VAPID RFC 8292), sans dépendance : uniquement WebCrypto.
// Le serveur chiffre le message pour CE téléphone (clés fournies par le navigateur à l'abonnement) : le service de push
// (Google, Mozilla…) ne peut pas le lire.
const enc = new TextEncoder();
export const b64u = {
  encode(b: Uint8Array): string { let s = ""; for (const x of b) s += String.fromCharCode(x); return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); },
  decode(s: string): Uint8Array { const t = s.replace(/-/g, "+").replace(/_/g, "/"); const p = t + "===".slice((t.length + 3) % 4); return Uint8Array.from(atob(p), (c) => c.charCodeAt(0)); },
};
const concat = (...a: Uint8Array[]) => { const out = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let o = 0; for (const x of a) { out.set(x, o); o += x.length; } return out; };
async function hmac(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey("raw", key as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, data as BufferSource));
}

export interface Subscription { endpoint: string; p256dh: string; auth: string }
export interface Vapid { publicKey: string; privateJwk: JsonWebKey; subject: string }

/** Clés VAPID du serveur (identité de l'expéditeur des notifications). */
export async function newVapid(subject: string): Promise<Vapid> {
  const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
  return { publicKey: b64u.encode(raw), privateJwk: await crypto.subtle.exportKey("jwk", kp.privateKey), subject };
}

/**
 * Chiffrement aes128gcm (RFC 8291). `ephemeral` et `salt` ne servent qu'aux tests (vecteurs du RFC) :
 * en temps normal, une paire de clés et un sel neufs sont tirés pour chaque message.
 */
export async function encrypt(sub: Subscription, plaintext: Uint8Array, test?: { asPrivateJwk: JsonWebKey; asPublic: Uint8Array; salt: Uint8Array }): Promise<Uint8Array> {
  const uaPublic = b64u.decode(sub.p256dh), authSecret = b64u.decode(sub.auth);
  let asPriv: CryptoKey, asPublic: Uint8Array;
  if (test) {
    asPriv = await crypto.subtle.importKey("jwk", test.asPrivateJwk, { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
    asPublic = test.asPublic;
  } else {
    const kp = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]) as CryptoKeyPair;
    asPriv = kp.privateKey; asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
  }
  const salt = test?.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const uaKey = await crypto.subtle.importKey("raw", uaPublic as BufferSource, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, asPriv, 256));
  const prkKey = await hmac(authSecret, ecdh);
  const ikm = await hmac(prkKey, concat(enc.encode("WebPush: info\0"), uaPublic, asPublic, new Uint8Array([1])));
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, concat(enc.encode("Content-Encoding: aes128gcm\0"), new Uint8Array([1])))).slice(0, 16);
  const nonce = (await hmac(prk, concat(enc.encode("Content-Encoding: nonce\0"), new Uint8Array([1])))).slice(0, 12);
  const key = await crypto.subtle.importKey("raw", cek as BufferSource, "AES-GCM", false, ["encrypt"]);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce as BufferSource }, key, concat(plaintext, new Uint8Array([2])) as BufferSource));
  const rs = new Uint8Array([0, 0, 16, 0]); // taille d'enregistrement 4096
  return concat(salt, rs, new Uint8Array([asPublic.length]), asPublic, ct);
}

/** Jeton VAPID (JWT ES256) pour le service de push de cet abonnement. */
export async function vapidAuth(endpoint: string, v: Vapid, now = Date.now()): Promise<string> {
  const aud = new URL(endpoint).origin;
  const head = b64u.encode(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const body = b64u.encode(enc.encode(JSON.stringify({ aud, exp: Math.floor(now / 1000) + 12 * 3600, sub: v.subject })));
  const key = await crypto.subtle.importKey("jwk", v.privateJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(`${head}.${body}`)));
  return `vapid t=${head}.${body}.${b64u.encode(sig)}, k=${v.publicKey}`;
}

/** Envoie une notification. Renvoie le code HTTP (404/410 = abonnement expiré, à supprimer). */
export async function sendPush(sub: Subscription, v: Vapid, payload: { title: string; body: string; tag?: string; url?: string }): Promise<number> {
  const data = await encrypt(sub, enc.encode(JSON.stringify(payload)));
  const res = await fetch(sub.endpoint, {
    method: "POST", signal: AbortSignal.timeout(10_000),
    headers: { authorization: await vapidAuth(sub.endpoint, v), ttl: "86400", urgency: "high", "content-encoding": "aes128gcm", "content-type": "application/octet-stream" },
    body: data as BufferSource,
  });
  return res.status;
}
