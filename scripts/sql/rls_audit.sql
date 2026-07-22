-- ============================================================
--  RLS 健全性チェック（読み取り専用・定期実行推奨）／棚卸2026-07-22
--  Supabase SQL Editor で Run。1行でも返れば「要対応」。0行＝健全。
--
--  検出クラス:
--    A. public の実テーブルで RLS 未有効
--    B. facility 列を持つ表に「書き込み可能な全開ポリシー(using true の ALL/INSERT/UPDATE/DELETE)」
--       ＝ログインすれば全宿を書き換え可能。人件費②・予算②-b はこれだった。
--       （SELECT の read-all はマスタで正当なため対象外。ただし allowlist 外の read-all は C で拾う）
--    C. facility 列を持つのに can_access_facility を参照するポリシーが皆無
--       （allowlist=マスタ全員読み / user・role・API(service_role)スコープ の表 を除外）
--
--  ※ allowlist は「facility列は持つが施設スコープではなく別方式で守る」表の台帳。
--    新テーブルを足したらここも更新する。判断に迷う行が出たら潰すか allowlist に追記。
--  ※ anon(未ログイン)で全件0の検査は SQL 単体では測れない → Node の2クライアント走査で別途。
-- ============================================================

with
allow as (  -- 施設スコープ“でなくてよい”表（意図的な例外）
  select unnest(array[
    -- マスタ（全員読み・書きは admin）:
    'dim_facility','dim_facility_profile','dim_facility_mapping',
    'dim_role','dim_shift_pattern','dim_variance_reason',
    'dim_survey_question','dim_axis_mapping',
    -- user / role / API(service_role) スコープ（facility列は持つが施設ゲートではない）:
    'app_user','user_facility','budget_lock',
    'ai_feedback','ai_issue','ai_config','chat_message','golden_question'
  ]) as tablename
),
fac_tables as (  -- facility / work_facility 列を持つ public 実テーブル
  select distinct c.relname as tablename
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  join information_schema.columns col
    on col.table_schema = 'public' and col.table_name = c.relname
  where n.nspname = 'public' and c.relkind = 'r'
    and col.column_name in ('facility','work_facility')
),
a as (  -- A: RLS未有効
  select 'A: RLS未有効'::text as issue, c.relname as object, ''::text as detail
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity = false
),
b as (  -- B: facility表に書込可能な全開ポリシー(using true)
  select 'B: 書込全開(using true)'::text as issue, p.tablename as object,
         (p.policyname || ' / ' || p.cmd) as detail
  from pg_policies p
  join fac_tables ft on ft.tablename = p.tablename
  where p.schemaname = 'public'
    and coalesce(p.qual, '') in ('true','(true)')
    and p.cmd in ('ALL','INSERT','UPDATE','DELETE')
    and p.tablename not in (select tablename from allow)
),
c as (  -- C: facility表なのに施設ゲート皆無（allowlist除外）
  select 'C: 施設ゲート不在'::text as issue, ft.tablename as object, ''::text as detail
  from fac_tables ft
  where ft.tablename not in (select tablename from allow)
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
