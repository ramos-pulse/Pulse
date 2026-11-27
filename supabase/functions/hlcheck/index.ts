// Fonction TEMPORAIRE (supprimée juste après) : renvoie seulement les adresses PUBLIQUES dérivées des secrets Hyperliquid.
import { addressOf } from "./evm.ts";
Deno.serve(() => {
  const k = (Deno.env.get("HL_AGENT_PRIVATE_KEY") ?? "").trim();
  let agent = "absente";
  try { if (k) agent = addressOf(k.startsWith("0x") ? k : "0x" + k); } catch { agent = "clé illisible"; }
  return new Response(JSON.stringify({ agent, account: (Deno.env.get("HL_ACCOUNT_ADDRESS") ?? "absente").trim().toLowerCase(), venue: Deno.env.get("PERPS_VENUE") ?? null }), { headers: { "content-type": "application/json" } });
});
