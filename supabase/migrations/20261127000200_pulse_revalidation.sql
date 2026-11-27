-- Re-validation hebdomadaire des stratégies (remplace l'expiration à 14 jours) : date du dernier contrôle sur données récentes
alter table public.research add column if not exists validated_at timestamptz;
