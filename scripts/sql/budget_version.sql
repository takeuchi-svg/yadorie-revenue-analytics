-- ============================================================
--  予算 版管理（B2）: budget_daily / budget_monthly に version 追加
--  Supabase SQL Editor で全文 Run（冪等）
--
--  方針: version TEXT NOT NULL DEFAULT '当初'。既存行は全て '当初' になる＝挙動不変。
--        当初予算=評価の基準(期中変更しない)。修正/見込は別versionとして併存。
--        全READ・全マート・mart_ai は version='当初'（当初予算=基準）で読む。
--        版切替UI(予実の比較版)・見込(残月上書き)は後続ステップ(B7/B8)で扱う。
--  ※ actual_monthly には version を付けない（実績は1本。見込は budget 側の version）。
-- ============================================================

-- ---- 1) version 列 ----
alter table budget_daily   add column if not exists version text not null default '当初';
alter table budget_monthly add column if not exists version text not null default '当初';

-- ---- 2) UNIQUE を版込みに（import/upload の upsert onConflict もこの版込みキーに合わせる） ----
alter table budget_daily   drop constraint if exists budget_daily_facility_date_key;
alter table budget_daily   drop constraint if exists budget_daily_uq_v;
alter table budget_daily   add  constraint budget_daily_uq_v unique (facility, date, version);

alter table budget_monthly drop constraint if exists budget_monthly_facility_fiscal_year_month_item_code_key;
alter table budget_monthly drop constraint if exists budget_monthly_uq_v;
alter table budget_monthly add  constraint budget_monthly_uq_v unique (facility, fiscal_year, month, item_code, version);

-- ---- 3) 公開マート: 当初予算(version='当初')のみを基準として集計 ----
create or replace view mart_budget_revenue_monthly as
select facility, month, amount as revenue_budget
from budget_monthly
where item_code = 'sales_total' and version = '当初';

create or replace view mart_budget_daily_monthly as
select
  facility,
  to_char(date, 'YYYY-MM') as month,
  sum(rooms_sold)    as rooms_budget,
  sum(total_revenue) as revenue_budget,
  sum(inventory)     as inventory_budget
from budget_daily
where version = '当初'
group by facility, to_char(date, 'YYYY-MM');
alter view mart_budget_daily_monthly set (security_invoker = on);

-- ---- 4) mart_ai.budget_monthly: k-匿名維持のまま version='当初' に限定 ----
--   （mart_ai.mart_budget_revenue_monthly / mart_ai.mart_budget_daily_monthly は
--     上記公開マートの select * なので自動的に当初のみになる）
create or replace view mart_ai.budget_monthly as
select
  b.facility, b.fiscal_year, b.month, b.category, b.item_code, b.item_name,
  case when b.item_code in ('給料手当','賞与','通勤費','法定福利費','福利厚生費','雑給','labor_total',
                            '外注費','外注費_人材_','外注費_清掃_','外注費_その他_','業務委託料')
        and coalesce(sc.n, 0) < th.v
       then null else b.amount end as amount,
  b.ratio, b.sort_order
from public.budget_monthly b
left join lateral (
  select count(*) as n from public.dim_staff s
  where s.home_facility = b.facility and coalesce(s.is_spot, false) = false
) sc on true
cross join lateral (
  select coalesce((select value::int from public.ai_config where key = 'k_anon_min_staff'), 5) as v
) th
where b.version = '当初';

-- 確認: select version, count(*) from budget_monthly group by version;
--       select version, count(*) from budget_daily group by version;
-- ロールバック(版を廃止): 上記マートを元定義(version条件なし)へ戻し、UNIQUEを版なしに戻し、version列をdrop。
