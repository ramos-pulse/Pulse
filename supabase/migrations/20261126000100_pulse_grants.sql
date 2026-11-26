-- Les projets Supabase récents ne donnent plus d'accès automatique aux nouvelles tables.
-- Seule la fonction des bots (rôle service_role) peut lire et écrire ; l'app publique (anon) n'y a jamais accès.
grant usage on schema public to service_role;
grant select, insert, update, delete on public.bot_state to service_role;
grant select, insert, update, delete on public.trades to service_role;
grant usage, select on sequence public.trades_id_seq to service_role;
revoke all on public.bot_state, public.trades from anon, authenticated;
