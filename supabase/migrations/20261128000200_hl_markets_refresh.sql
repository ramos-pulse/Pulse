-- Nouveau seuil (5 M$/jour, 12 marchés) : la sélection Hyperliquid est refaite au prochain cycle de recherche.
update public.app_kv set updated_at = now() - interval '2 days' where key = 'hl_markets';
