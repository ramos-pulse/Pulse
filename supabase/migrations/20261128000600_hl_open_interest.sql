-- 28/11 : historique de l'intérêt ouvert Hyperliquid (Hyperliquid ne le fournit pas) : une mesure par heure et par marché.
-- Dans quelques semaines, le chercheur pourra tester des stratégies « prix + intérêt ouvert ».
create table if not exists public.hl_oi (
  coin     text not null,
  t        timestamptz not null,           -- début de l'heure mesurée
  oi_usd   double precision not null,      -- intérêt ouvert en dollars
  px       double precision not null,      -- prix de référence (mark)
  funding  double precision,               -- funding horaire du moment
  primary key (coin, t)
);
create index if not exists hl_oi_t on public.hl_oi (t desc);
grant select, insert, update, delete on public.hl_oi to service_role;
alter table public.hl_oi enable row level security;
revoke all on public.hl_oi from anon, authenticated;

-- 20 marchés Hyperliquid au lieu de 12 : le sélectionneur refait son choix au prochain passage (au lieu d'attendre demain)
update public.app_kv set updated_at = now() - interval '2 days' where key = 'hl_markets';
