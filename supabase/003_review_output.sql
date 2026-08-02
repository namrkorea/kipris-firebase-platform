
begin;

alter table public.collection_jobs
  add column if not exists report_title text not null default '특허 검색·검토 결과',
  add column if not exists review_purpose text not null default '',
  add column if not exists output_fields jsonb not null default
    '["applicationNumber","applicant","ipc","dates","status","abstract","pdf"]'::jsonb;

alter table public.collection_jobs
  drop constraint if exists collection_jobs_report_title_length_check,
  drop constraint if exists collection_jobs_review_purpose_length_check,
  drop constraint if exists collection_jobs_output_fields_type_check;

alter table public.collection_jobs
  add constraint collection_jobs_report_title_length_check
    check (char_length(report_title) <= 100),
  add constraint collection_jobs_review_purpose_length_check
    check (char_length(review_purpose) <= 500),
  add constraint collection_jobs_output_fields_type_check
    check (jsonb_typeof(output_fields) = 'array');

-- 기존 공개 작업 등록 함수를 결과 장표 입력값까지 저장하도록 교체

drop function if exists public.create_public_collection_job(
  text, text, integer, boolean, text
);

create or replace function public.create_public_collection_job(
  p_query_text text,
  p_search_field text,
  p_max_results integer,
  p_download_pdf boolean,
  p_requester_hash text,
  p_report_title text,
  p_review_purpose text,
  p_output_fields jsonb
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
  invalid_output_field text;
begin
  p_query_text := btrim(coalesce(p_query_text, ''));
  p_search_field := btrim(coalesce(p_search_field, ''));
  p_requester_hash := btrim(coalesce(p_requester_hash, ''));
  p_report_title := btrim(coalesce(p_report_title, '특허 검색·검토 결과'));
  p_review_purpose := btrim(coalesce(p_review_purpose, ''));
  p_output_fields := coalesce(
    p_output_fields,
    '["applicationNumber","applicant","ipc","dates","status","abstract","pdf"]'::jsonb
  );

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

  if char_length(p_report_title) > 100 then
    raise exception '결과표 제목은 100자 이하로 입력하세요.';
  end if;

  if char_length(p_review_purpose) > 500 then
    raise exception '검토 목적은 500자 이하로 입력하세요.';
  end if;

  if jsonb_typeof(p_output_fields) <> 'array' then
    raise exception '결과표 출력 항목 형식이 올바르지 않습니다.';
  end if;

  select value
  into invalid_output_field
  from jsonb_array_elements_text(p_output_fields) as item(value)
  where value not in (
    'applicationNumber',
    'applicant',
    'ipc',
    'dates',
    'status',
    'abstract',
    'pdf'
  )
  limit 1;

  if invalid_output_field is not null then
    raise exception '지원하지 않는 결과표 출력 항목입니다: %', invalid_output_field;
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
    report_title,
    review_purpose,
    output_fields,
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
    coalesce(nullif(p_report_title, ''), '특허 검색·검토 결과'),
    p_review_purpose,
    p_output_fields,
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
  text, text, integer, boolean, text, text, text, jsonb
) from public, anon, authenticated;

grant execute on function public.create_public_collection_job(
  text, text, integer, boolean, text, text, text, jsonb
) to service_role;

commit;
