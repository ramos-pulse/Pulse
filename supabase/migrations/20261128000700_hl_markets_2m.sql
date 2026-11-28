-- 28/11 : marchés Hyperliquid dès 2 M$ échangés par jour (20 au maximum) : le sélectionneur refait son choix au prochain passage
update public.app_kv set updated_at = now() - interval '2 days' where key = 'hl_markets';
