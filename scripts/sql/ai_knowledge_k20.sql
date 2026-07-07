-- ============================================================
--  AIナレッジ基盤 第2弾 K10残（Phase 1）── 構造化データの下書き/公開/履歴 化
--  Supabase SQL Editor で全文 Run（冪等）
--
--  目的: kpi_definition / glossary / standard_pl_master を
--        ai_prompt / ai_knowledge と同じ「下書き→公開・変更メモ・履歴・ロールバック」作法に揃える。
--        （克樹さんのレビュー前に本番公開しない＝status で注入を制御するため）
--
--  内容:
--   [1] 3テーブルに status / draft_content(JSONB) 列を追加（既存行は 'draft' 起点＝未公開）
--   [2] 版履歴テーブル 3種（*_version。content=公開時点の全編集フィールドのJSONスナップショット）
--   [3] 版履歴の閲覧RLS（本体と同じ min_role_view 相当）。書き込みはAPI(service_role)のみ
--
--  非回帰: 中身が空／status='draft' の間は注入エンジンが読まない（灯は従来通り動く）。
--  ロールバック: 末尾コメントの DROP / ALTER DROP COLUMN を実行。
-- ============================================================

-- ---- [1] 本体テーブルに status / draft_content を追加 ----
-- status: 'draft'=未公開（注入されない）/ 'published'=公開（注入対象）
-- draft_content: 公開中の列とは別に保持する編集中フィールドのJSON（プレビュー・下書き用）
alter table kpi_definition
  add column if not exists status TEXT not null default 'draft',
  add column if not exists draft_content JSONB;
alter table glossary
  add column if not exists status TEXT not null default 'draft',
  add column if not exists draft_content JSONB;
alter table standard_pl_master
  add column if not exists status TEXT not null default 'draft',
  add column if not exists draft_content JSONB;

-- status の値域チェック（冪等: 既存制約があれば張り直し）
do $$
declare t text;
begin
  foreach t in array array['kpi_definition','glossary','standard_pl_master'] loop
    execute format('alter table %I drop constraint if exists %I', t, t || '_status_chk');
    execute format($f$alter table %I add constraint %I check (status in ('draft','published'))$f$, t, t || '_status_chk');
  end loop;
end $$;

-- ---- [2] 版履歴テーブル ----
create table if not exists kpi_definition_version (
  id BIGSERIAL primary key,
  kpi_key TEXT not null references kpi_definition(kpi_key) on delete cascade,
  content JSONB not null,            -- 公開時点の {label_ja,formula,numerator,denominator,unit,direction,note}
  status TEXT not null,
  change_note TEXT not null,         -- 変更メモ必須
  changed_by TEXT not null,
  changed_at TIMESTAMPTZ default now()
);
create index if not exists kpi_definition_version_key_idx on kpi_definition_version(kpi_key, changed_at desc);

create table if not exists glossary_version (
  id BIGSERIAL primary key,
  term TEXT not null references glossary(term) on delete cascade,
  content JSONB not null,            -- {definition_ja,note}
  status TEXT not null,
  change_note TEXT not null,
  changed_by TEXT not null,
  changed_at TIMESTAMPTZ default now()
);
create index if not exists glossary_version_term_idx on glossary_version(term, changed_at desc);

create table if not exists standard_pl_master_version (
  id BIGSERIAL primary key,
  std_id BIGINT not null references standard_pl_master(id) on delete cascade,
  content JSONB not null,            -- {facility_type,item_key,value,unit,note}
  status TEXT not null,
  change_note TEXT not null,
  changed_by TEXT not null,
  changed_at TIMESTAMPTZ default now()
);
create index if not exists standard_pl_master_version_id_idx on standard_pl_master_version(std_id, changed_at desc);

-- ---- [3] 版履歴の閲覧RLS（本体の閲覧権限に合わせる。書き込みはservice_roleのみ＝ポリシー無し） ----
alter table kpi_definition_version enable row level security;
alter table glossary_version enable row level security;
alter table standard_pl_master_version enable row level security;
do $$
declare t text; pol record;
begin
  foreach t in array array['kpi_definition_version','glossary_version','standard_pl_master_version'] loop
    for pol in select policyname from pg_policies where schemaname = 'public' and tablename = t loop
      execute format('drop policy %I on %I', pol.policyname, t);
    end loop;
  end loop;
end $$;
-- KPI辞書・用語集の版 = 親と同じ min_role_view（既定 admin）。基準PLの版 = admin 以上。
create policy kpi_definition_version_view on kpi_definition_version for select to authenticated
  using (exists (select 1 from kpi_definition x where x.kpi_key = kpi_definition_version.kpi_key
                   and public.role_rank(public.my_role()) >= public.role_rank(x.min_role_view)));
create policy glossary_version_view on glossary_version for select to authenticated
  using (exists (select 1 from glossary x where x.term = glossary_version.term
                   and public.role_rank(public.my_role()) >= public.role_rank(x.min_role_view)));
create policy standard_pl_master_version_view on standard_pl_master_version for select to authenticated
  using (public.role_rank(public.my_role()) >= public.role_rank('admin'));

-- ---- 動作確認 ----
-- select kpi_key, status, (draft_content is not null) as has_draft from kpi_definition order by kpi_key;
-- select count(*) from kpi_definition_version;

-- ---- ロールバック（必要時のみ） ----
-- drop table if exists kpi_definition_version, glossary_version, standard_pl_master_version cascade;
-- alter table kpi_definition       drop column if exists status, drop column if exists draft_content;
-- alter table glossary             drop column if exists status, drop column if exists draft_content;
-- alter table standard_pl_master   drop column if exists status, drop column if exists draft_content;
