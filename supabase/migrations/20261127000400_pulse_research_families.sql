-- La contrainte d'origine n'acceptait que 'tendance' et 'rsi' : toute recherche contenant une autre famille (range, ORB,
-- VWAP, compression, volume, funding) était refusée en bloc par la base. On l'enlève : la famille est validée par le moteur.
alter table public.research drop constraint if exists research_family_check;
