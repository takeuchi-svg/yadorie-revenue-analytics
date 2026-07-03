-- ============================================================
--  改善レポート キャッシュ（C4拡張）  Supabase SQL Editor で実行（冪等）
--  改善候補TOP3の各トピックについて、AIが生成した
--  「課題の特定・実クチコミ引用・解決策①②③」を保存する。
-- ============================================================
create table if not exists raw_improvement_insight (
  id BIGSERIAL primary key,
  facility TEXT not null,
  month TEXT not null,                 -- 期間の終端月 'YYYY-MM'
  window_months INTEGER not null default 3,  -- 1 | 3 | 12
  topic_code TEXT not null,
  topic_label TEXT,
  problem TEXT,                        -- 課題の特定（なぜ改善候補か）
  evidence JSONB,                      -- [{quote, source, review_date, rating}] 実クチコミ引用
  solutions JSONB,                     -- [{title, detail, effort:'低'|'中'|'高'}] 実施しやすい順
  model_version TEXT,
  created_at TIMESTAMPTZ default now(),
  unique (facility, month, window_months, topic_code, model_version)
);
alter table raw_improvement_insight enable row level security;
do $$
declare pol record;
begin
  for pol in select policyname from pg_policies where schemaname='public' and tablename='raw_improvement_insight' loop
    execute format('drop policy %I on raw_improvement_insight', pol.policyname);
  end loop;
end $$;
create policy insight_facility_scope on raw_improvement_insight
  for all to authenticated
  using (public.can_access_facility(facility))
  with check (public.can_access_facility(facility));
