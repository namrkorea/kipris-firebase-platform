-- KIPRIS 공개 특허 수집·검색 플랫폼
-- Supabase SQL Editor에서 전체 실행

begin;

create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  display_name text,
  role text not null default 'analyst'
    check (role in ('admin', 'analyst')),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (
    id, email, display_name, role, is_active
  )
  values (
    new.id,
    new.email,
    coalesce(
      new.raw_user_meta_data ->> 'display_name',
      split_part(new.email, '@', 1)
    ),
    'analyst',
    true
  )
  on conflict (id) do update
  set
    email = excluded.email,
    display_name = coalesce(public.profiles.display_name, excluded.display_name);

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert or update of email on auth.users
for each row execute function public.handle_new_user();

insert into public.profiles (id, email, display_name, role, is_active)
select
  id,
  email,
  coalesce(raw_user_meta_data ->> 'display_name', split_part(email, '@', 1)),
  'analyst',
  true
from auth.users
on conflict (id) do nothing;

update public.profiles
set role = 'analyst', is_active = true
where role <> 'admin';

create table if not exists public.collection_jobs (
  id uuid primary key default gen_random_uuid(),
  requested_by uuid not null references public.profiles(id) on delete cascade,
  query_text text not null check (char_length(query_text) between 2 and 200),
  search_field text not null default 'word'
    check (
      search_field in (
        'word',
        'inventionTitle',
        'applicant',
        'ipcNumber',
        'applicationNumber',
        'publicationNumber',
        'registerNumber'
      )
    ),
  max_results integer not null default 30 check (max_results between 1 and 100),
  download_pdf boolean not null default true,
  status text not null default 'queued'
    check (status in ('queued', 'running', 'completed', 'failed', 'cancelled')),
  progress_current integer not null default 0,
  progress_total integer not null default 0,
  result_count integer not null default 0,
  error_message text,
  worker_id text,
  locked_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists collection_jobs_status_created_idx
  on public.collection_jobs(status, created_at);

create index if not exists collection_jobs_user_created_idx
  on public.collection_jobs(requested_by, created_at desc);

create table if not exists public.patents (
  id uuid primary key default gen_random_uuid(),
  application_number text not null unique,
  invention_title text,
  applicant_name text,
  ipc_number text,
  register_status text,
  register_number text,
  register_date text,
  application_date text,
  open_number text,
  open_date text,
  publication_number text,
  publication_date text,
  abstract text,
  drawing_url text,
  big_drawing_url text,
  detail_xml text,
  raw_search_json jsonb not null default '{}'::jsonb,
  pdf_storage_path text,
  is_public boolean not null default true,
  first_collected_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists patents_application_date_idx
  on public.patents(application_date desc);

create index if not exists patents_public_idx
  on public.patents(is_public);

create index if not exists patents_search_idx
  on public.patents using gin (
    to_tsvector(
      'simple',
      coalesce(invention_title, '') || ' ' ||
      coalesce(applicant_name, '') || ' ' ||
      coalesce(ipc_number, '') || ' ' ||
      coalesce(abstract, '') || ' ' ||
      coalesce(application_number, '')
    )
  );

create table if not exists public.job_patents (
  job_id uuid not null references public.collection_jobs(id) on delete cascade,
  patent_id uuid not null references public.patents(id) on delete cascade,
  display_order integer not null default 0,
  created_at timestamptz not null default now(),
  primary key (job_id, patent_id)
);

create table if not exists public.patent_documents (
  id uuid primary key default gen_random_uuid(),
  patent_id uuid not null references public.patents(id) on delete cascade,
  document_type text not null default 'publication_pdf',
  storage_bucket text not null default 'patent-pdfs',
  storage_path text not null,
  original_name text,
  byte_size bigint,
  created_at timestamptz not null default now(),
  unique (patent_id, document_type)
);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at
before update on public.profiles
for each row execute function public.set_updated_at();

drop trigger if exists collection_jobs_set_updated_at on public.collection_jobs;
create trigger collection_jobs_set_updated_at
before update on public.collection_jobs
for each row execute function public.set_updated_at();

drop trigger if exists patents_set_updated_at on public.patents;
create trigger patents_set_updated_at
before update on public.patents
for each row execute function public.set_updated_at();

create or replace function public.enforce_collection_job_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  daily_count integer;
begin
  select count(*)
  into daily_count
  from public.collection_jobs
  where requested_by = new.requested_by
    and created_at >= date_trunc('day', now());

  if daily_count >= 20 then
    raise exception '하루 수집 요청 한도 20건을 초과했습니다.';
  end if;

  return new;
end;
$$;

drop trigger if exists collection_jobs_daily_limit on public.collection_jobs;
create trigger collection_jobs_daily_limit
before insert on public.collection_jobs
for each row execute function public.enforce_collection_job_limit();

create or replace function public.claim_next_collection_job(p_worker_id text)
returns setof public.collection_jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job public.collection_jobs%rowtype;
begin
  select *
  into v_job
  from public.collection_jobs
  where status = 'queued'
  order by created_at
  for update skip locked
  limit 1;

  if not found then
    return;
  end if;

  update public.collection_jobs
  set
    status = 'running',
    worker_id = p_worker_id,
    locked_at = now(),
    started_at = coalesce(started_at, now()),
    error_message = null
  where id = v_job.id
  returning * into v_job;

  return next v_job;
end;
$$;

revoke all on function public.claim_next_collection_job(text) from public;
revoke all on function public.claim_next_collection_job(text) from anon;
revoke all on function public.claim_next_collection_job(text) from authenticated;
grant execute on function public.claim_next_collection_job(text) to service_role;

alter table public.profiles enable row level security;
alter table public.collection_jobs enable row level security;
alter table public.patents enable row level security;
alter table public.job_patents enable row level security;
alter table public.patent_documents enable row level security;

drop policy if exists profiles_select_own on public.profiles;
create policy profiles_select_own
on public.profiles for select
to authenticated
using (id = auth.uid());

drop policy if exists jobs_select_own on public.collection_jobs;
create policy jobs_select_own
on public.collection_jobs for select
to authenticated
using (requested_by = auth.uid());

drop policy if exists jobs_insert_own on public.collection_jobs;
create policy jobs_insert_own
on public.collection_jobs for insert
to authenticated
with check (
  requested_by = auth.uid()
  and exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and p.is_active = true
      and p.role in ('admin', 'analyst')
  )
);

drop policy if exists patents_public_select on public.patents;
create policy patents_public_select
on public.patents for select
to anon, authenticated
using (is_public = true);

drop policy if exists job_patents_select_own on public.job_patents;
create policy job_patents_select_own
on public.job_patents for select
to authenticated
using (
  exists (
    select 1
    from public.collection_jobs j
    where j.id = job_id
      and j.requested_by = auth.uid()
  )
);

drop policy if exists patent_documents_no_direct_access on public.patent_documents;
create policy patent_documents_no_direct_access
on public.patent_documents for select
to authenticated
using (false);

grant select on public.profiles to authenticated;
grant select, insert on public.collection_jobs to authenticated;
grant select on public.patents to anon, authenticated;
grant select on public.job_patents to authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'patent-pdfs',
  'patent-pdfs',
  false,
  52428800,
  array['application/pdf']
)
on conflict (id) do update
set
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists patent_pdfs_no_browser_select on storage.objects;
create policy patent_pdfs_no_browser_select
on storage.objects for select
to authenticated
using (false);

do $$
begin
  alter publication supabase_realtime add table public.collection_jobs;
exception
  when duplicate_object then null;
end
$$;

commit;
