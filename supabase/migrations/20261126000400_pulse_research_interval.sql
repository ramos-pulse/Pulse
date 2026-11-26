-- Le chercheur teste aussi le scalping (bougies 15 min) et d'autres tokens / marchés perps.
alter table public.research add column if not exists interval text not null default '1h';
alter table public.research add column if not exists symbol text;
