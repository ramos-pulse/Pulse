-- « Pourquoi ce trade ? » : détails de chaque trade (raison d'entrée, stop, stratégie, durée, coffre)
alter table public.trades add column if not exists detail jsonb;
