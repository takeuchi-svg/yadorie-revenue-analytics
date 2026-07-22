-- ============================================================
--  RLS 健全性チェック（読み取り専用・定期実行推奨）／棚卸2026-07-22 新設
--  Supabase SQL Editor で Run。1つでも行が返ったら「要対応」。0行＝健全。
--
--  検出する3クラス（②のような穴を機械的に炙り出す）:
--    A. public の実テーブルで RLS 未有効
--    B. facility / work_facility 列を持つのに using(true) の全開ポリシーがある
--       （＝ログインさえすれば全宿を読める。人件費②はこれだった）
--    C. facility / work_facility 列を持つのに can_access_facility を参照する
--       ポリシーが1つも無い（マスタ等の“全員読み”は allowlist で除外）
--
--  ※ anon（未ログイン）で全件0を確認する検査は SQL 単体では測れないため、
--    別途 Node の2クライアント走査（service_role と anon で全オブジェクトを突合）で実施する。
--    → scripts/ の点検スクリプト、または CI に組み込む。手順は docs/運用手順書.md。
-- ============================================================

with
-- 意図的に「全員読み(true)」で良いマスタ等（Cクラスの除外リスト）
allow_open as (
  select unnest(array[
    'dim_facility','dim_facility_profile','dim_facility_mapping',
    'dim_role','dim_shift_pattern','dim_variance_reason',
    'dim_survey_question','dim_axis_mapping','budget_lock'
  ]) as tablename
),
fac_tables as (  -- facility か work_facility 列を持つ public 実テーブル
  select distinct c.relname as tablename
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  join information_schema.columns col
    on col.table_schema = 'public' and col.table_name = c.relname
  where n.nspname = 'public' and c.relkind = 'r'
    and col.column_name in ('facility','work_facility')
),
-- A: RLS未有効の実テーブル
a as (
  select 'A: RLS未有効'::text as issue, c.relname as object, ''::text as detail
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity = false
),
-- B: facility列ありなのに using(true) の全開ポリシー
b as (
  select 'B: 全開ポリシー(using true)'::text as issue, p.tablename as object,
         (p.policyname || ' / ' || p.cmd) as detail
  from pg_policies p
  join fac_tables ft on ft.tablename = p.tablename
  where p.schemaname = 'public'
    and coalesce(p.qual, '') in ('true','(true)')
),
-- C: facility列ありなのに can_access_facility 参照ポリシーが皆無（allowlist除外）
c as (
  select 'C: 施設ゲート不在'::text as issue, ft.tablename as object, ''::text as detail
  from fac_tables ft
  where ft.tablename not in (select tablename from allow_open)
    and not exists (
      select 1 from pg_policies p
      where p.schemaname = 'public' and p.tablename = ft.tablename
        and coalesce(p.qual,'') like '%can_access_facility%'
    )
)
select * from a
union all select * from b
union all select * from c
order by 1, 2;
