-- Agent mathématicien : origine des stratégies et analyses statistiques des marchés
alter table public.research add column if not exists origin text not null default 'chercheur';
alter table public.research add column if not exists rationale text;
create table if not exists public.math_insights (
  key        text primary key,          -- produit|type|intervalle
  updated_at timestamptz not null default now(),
  market     text not null,
  kind       text not null,
  interval   text not null,
  regime     text not null,
  hurst      double precision,
  ac1        double precision,
  half_life  double precision,
  significant boolean,
  vr         jsonb,
  note       text,
  proposed   int not null default 0
);
grant select, insert, update, delete on public.math_insights to service_role;
alter table public.math_insights enable row level security;
revoke all on public.math_insights from anon, authenticated;
