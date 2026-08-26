-- Esegui in Supabase SQL editor (una volta)
create table if not exists cassa_chiusure (
  data date primary key,
  chiusa_by text,
  chiusa_at timestamptz default now(),
  versato boolean default false,
  versato_by text,
  versato_at timestamptz
);
alter table cassa_chiusure enable row level security;
drop policy if exists "cassa_chiusure_all" on cassa_chiusure;
create policy "cassa_chiusure_all" on cassa_chiusure for all using (true) with check (true);
