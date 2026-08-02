-- 로그인 없는 공개 수집 요청 전환 패치
-- 기존 001_schema.sql 실행 후 Supabase SQL Editor에서 한 번 실행

begin;

alter table public.collection_jobs
  alter column requested_by drop not null;

alter table public.collection_jobs
  add column if not exists public_token uuid not null default gen_random_uuid(),
  add column if not exists requester_hash text,
  add column if not exists request_source text not null default 'public';

create unique index if not exists collection_jobs_public_token_uidx
  on public.collection_jobs(public_token);

create index if not exists collection_jobs_requester_created_idx
  on public.collection_jobs(requester_hash, created_at desc);

alter table public.collection_jobs
  drop constraint if exists collection_jobs_request_source_check;

alter table public.collection_jobs
  add constraint collection_jobs_request_source_check
  check (request_source in ('public', 'authenticated', 'admin'));

-- 기존 사용자 제한 트리거를 익명 요청까지 처리하도록 교체
create or replace function public.enforce_collection_job_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  daily_count integer;
begin
  if new.requested_by is not null then
    select count(*)
    into daily_count
    from public.collection_jobs
    where requested_by = new.requested_by
      and created_at >= date_trunc('day', now());
  elsif new.requester_hash is not null then
    select count(*)
    into daily_count
    from public.collection_jobs
    where requester_hash = new.requester_hash
      and created_at >= date_trunc('day', now());
  else
    raise exception '요청자 식별정보가 없습니다.';
  end if;

  if daily_count >= 20 then
    raise exception '하루 수집 요청 한도 20건을 초과했습니다.';
  end if;

  return new;
end;
$$;

-- Vercel 서버에서만 호출하는 익명 작업 등록 함수
create or replace function public.create_public_collection_job(
  p_query_text text,
  p_search_field text,
  p_max_results integer,
  p_download_pdf boolean,
  p_requester_hash text
)
returns table (
  id uuid,
  public_token uuid
)
language plpgsql
security definer
set search_path = public
as $$
declare
  hourly_count integer;
  daily_count integer;
  created_id uuid;
  created_token uuid;
begin
  p_query_text := btrim(coalesce(p_query_text, ''));
  p_search_field := btrim(coalesce(p_search_field, ''));
  p_requester_hash := btrim(coalesce(p_requester_hash, ''));

  if char_length(p_query_text) < 2 or char_length(p_query_text) > 200 then
    raise exception '검색어는 2자 이상 200자 이하로 입력하세요.';
  end if;

  if p_search_field not in (
    'word',
    'inventionTitle',
    'applicant',
    'ipcNumber',
    'applicationNumber',
    'publicationNumber',
    'registerNumber'
  ) then
    raise exception '지원하지 않는 검색 항목입니다.';
  end if;

  if p_max_results < 1 or p_max_results > 100 then
    raise exception '수집 건수는 1건 이상 100건 이하로 선택하세요.';
  end if;

  if char_length(p_requester_hash) <> 64 then
    raise exception '요청자 식별정보가 올바르지 않습니다.';
  end if;

  select count(*)
  into hourly_count
  from public.collection_jobs
  where requester_hash = p_requester_hash
    and created_at >= now() - interval '1 hour';

  if hourly_count >= 5 then
    raise exception '시간당 수집 요청 한도 5건을 초과했습니다.';
  end if;

  select count(*)
  into daily_count
  from public.collection_jobs
  where requester_hash = p_requester_hash
    and created_at >= date_trunc('day', now());

  if daily_count >= 20 then
    raise exception '하루 수집 요청 한도 20건을 초과했습니다.';
  end if;

  insert into public.collection_jobs (
    requested_by,
    query_text,
    search_field,
    max_results,
    download_pdf,
    requester_hash,
    request_source,
    status
  )
  values (
    null,
    p_query_text,
    p_search_field,
    p_max_results,
    coalesce(p_download_pdf, true),
    p_requester_hash,
    'public',
    'queued'
  )
  returning
    public.collection_jobs.id,
    public.collection_jobs.public_token
  into created_id, created_token;

  return query
  select created_id, created_token;
end;
$$;

revoke all on function public.create_public_collection_job(
  text, text, integer, boolean, text
) from public;

revoke all on function public.create_public_collection_job(
  text, text, integer, boolean, text
) from anon, authenticated;

grant execute on function public.create_public_collection_job(
  text, text, integer, boolean, text
) to service_role;

-- 익명 브라우저는 collection_jobs 테이블을 직접 읽거나 쓰지 못함
revoke all on public.collection_jobs from anon;

commit;
