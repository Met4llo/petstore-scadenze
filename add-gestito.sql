-- Esegui in Supabase SQL editor (una volta)
alter table scadenze add column if not exists gestito boolean default false;
alter table scadenze add column if not exists gestito_expiry date;
