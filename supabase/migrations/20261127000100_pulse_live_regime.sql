-- Régime de marché EN DIRECT (300 dernières bougies), mesuré par le mathématicien : oriente le pilote automatique
alter table public.math_insights add column if not exists live_regime text;
alter table public.math_insights add column if not exists live_note text;
