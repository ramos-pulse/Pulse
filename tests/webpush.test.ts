// Notifications push : chiffrement vérifié avec l'exemple officiel du RFC 8291 (section 5), jeton VAPID vérifiable.
import { test } from "node:test";
import assert from "node:assert/strict";
import { b64u, encrypt, newVapid, vapidAuth } from "../supabase/functions/pulse/engine/webpush.ts";

test("chiffrement Web Push identique à l'exemple du RFC 8291", async () => {
  const asPublic = b64u.decode("BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8");
  const jwk = { kty: "EC", crv: "P-256", d: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw", x: b64u.encode(asPublic.slice(1, 33)), y: b64u.encode(asPublic.slice(33, 65)), ext: true };
  const out = await encrypt({ endpoint: "https://push.example.net", p256dh: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4", auth: "BTBZMqHH6r4Tts7J_aSIgg" },
    new TextEncoder().encode("When I grow up, I want to be a watermelon"), { asPrivateJwk: jwk, asPublic, salt: b64u.decode("DGv6ra1nlYgDCS1FRnbzlw") });
  assert.equal(b64u.encode(out), "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN");
});

test("jeton VAPID : signature ES256 valide pour le service de push", async () => {
  const v = await newVapid("mailto:pulse@example.com");
  const h = await vapidAuth("https://fcm.googleapis.com/fcm/send/abc", v, Date.UTC(2026, 10, 27));
  const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(h)!;
  assert.ok(m, h);
  const payload = JSON.parse(new TextDecoder().decode(b64u.decode(m[2]!)));
  assert.equal(payload.aud, "https://fcm.googleapis.com");
  const pub = await crypto.subtle.importKey("raw", b64u.decode(m[4]!), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  assert.ok(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pub, b64u.decode(m[3]!), new TextEncoder().encode(`${m[1]}.${m[2]}`)));
});
