-- 28/11 : le 2e XMR (fermé à 13:00 UTC) a été enregistré à +1,037 $ au lieu de +0,034 $ réels : la fermeture du 1er XMR,
-- 40 s avant l'ouverture, était comptée une seconde fois. Corrections ponctuelles : le trade et le coffre (25 % du faux gain).
update trades
set pnl_usd = 0.034, collateral_usd = coalesce(collateral_usd, 0) - 1.003,
    detail = coalesce(detail, '{}'::jsonb) || '{"correction": "résultat corrigé le 28/11 : +0,034 $ réels (la fermeture du trade précédent était comptée deux fois)"}'::jsonb
where bot = 'perps' and action = 'close' and asset = 'XMR' and pnl_usd > 1
  and created_at between '2026-11-28 13:00:00+00' and '2026-11-28 13:01:30+00';
update bot_state
set price_history = jsonb_set(price_history, '{vault}', to_jsonb(greatest(0, round(((price_history->>'vault')::numeric - 0.2508), 4))))
where kind = 'perps' and (price_history->>'vault')::numeric > 0.4;
