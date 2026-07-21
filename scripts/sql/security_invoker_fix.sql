-- ============================================================
--  棚卸監査(2026-07-21)で発見したビューの権限漏れ修復／冪等
--  Supabase SQL Editor に全文貼付→Run。
--
--  発見事象（anonキー＝未ログインで SELECT できた）:
--   1) mart_occupancy_monthly    … mart_occupancy_calendar.sql の再定義時に invoker=on が消失
--   2) mart_budget_revenue_monthly … budget_version.sql の再定義時に invoker=on 未設定
--   3) mart_daily_plan_context   … shift_extras.sql の再定義時に invoker=on 未設定
--   4) mart_labor_cost_monthly   … labor_model_v2_phase3.sql の再定義で
--                                  施設アクセスの自前ゲート(WHERE)が脱落（invoker=off のまま）
--  併せて mart_shift_variance_monthly（invoker=off）にも自前ゲートを追加する。
-- ============================================================

-- ---- 1〜3) invoker=on へ戻す（下表RLSを閲覧者権限で継承） ----
alter view mart_occupancy_monthly      set (security_invoker = on);
alter view mart_budget_revenue_monthly set (security_invoker = on);
alter view mart_daily_plan_context     set (security_invoker = on);

-- ---- 4) mart_labor_cost_monthly を自前ゲート付きで再作成（invoker=off 維持） ----
--  本体は labor_model_v2_phase3.sql と同一。最終SELECTに can_access_facility ゲートを追加。
drop view if exists mart_labor_cost_monthly;
create view mart_labor_cost_monthly as
with att as (
  select a.staff_code, a.work_facility as facility,
         to_char(date_trunc('month', a.work_date), 'YYYY-MM') as month,
         a.work_date, a.total_work_min,
         coalesce(s.is_spot, false)                       as is_spot,
         coalesce(s.employment_type, a.employment_type)   as emp
  from raw_attendance_daily a
  left join dim_staff s on s.staff_code = a.staff_code
),
pt as (  -- アルバイト実働時間（スポット除く）
  select facility, month, sum(total_work_min) / 60.0 as hours
  from att where emp = 'アルバイト' and not is_spot
  group by 1, 2
),
pt_cost as (  -- 時間 × 宿の標準時給
  select pt.facility, pt.month, pt.hours,
         round(pt.hours * coalesce(r.hourly_wage, 0)) as cost
  from pt left join dim_labor_rate r on r.facility = pt.facility
),
spot as (  -- スポット: 計画の日当/時給 × 実働
  select att.facility, att.month,
         sum(att.total_work_min) / 60.0 as hours,
         sum(case
               when p.spot_wage_kind = '日当' then coalesce(p.spot_wage_amount, 0)
               when p.spot_wage_kind = '時給' then round(att.total_work_min / 60.0 * coalesce(p.spot_wage_amount, 0))
               else 0 end) as cost
  from att
  left join raw_shift_plan p
    on p.staff_code = att.staff_code and p.work_facility = att.facility and p.work_date = att.work_date
  where att.is_spot
  group by 1, 2
),
reg as (  -- 正社員: 宿×月の合計額
  select facility, month, amount as cost from raw_regular_labor_monthly
),
keys as (
  select facility, month from pt_cost
  union select facility, month from spot
  union select facility, month from reg
)
select
  k.facility, k.month,
  coalesce(reg.cost, 0)                                                    as regular_cost,
  coalesce(pt_cost.cost, 0)                                               as parttime_cost,
  coalesce(pt_cost.hours, 0)                                             as parttime_hours,
  coalesce(spot.cost, 0)                                                  as spot_cost,
  coalesce(spot.hours, 0)                                                as spot_hours,
  coalesce(reg.cost, 0) + coalesce(pt_cost.cost, 0) + coalesce(spot.cost, 0) as labor_cost
from keys k
left join reg     on reg.facility = k.facility     and reg.month = k.month
left join pt_cost on pt_cost.facility = k.facility and pt_cost.month = k.month
left join spot    on spot.facility = k.facility    and spot.month = k.month
where public.can_access_facility(k.facility);   -- ★自前ゲート（admin/owner or 担当宿メンバー）
alter view mart_labor_cost_monthly set (security_invoker = off);

-- ---- 5) mart_shift_variance_monthly にも自前ゲートを追加（invoker=off 維持） ----
--  本体は labor_model_v2_phase3.sql と同一。最終SELECTにゲートを追加。
create or replace view mart_shift_variance_monthly as
with baseline as (
  select pub.facility, pub.target_month as ym, sum(s.planned_minutes) as baseline_min
  from shift_plan_publication pub
  join raw_shift_plan_snapshot s on s.publication_id = pub.id
  where pub.is_baseline group by 1, 2
),
final_actual as (
  select facility, date_trunc('month', work_date)::date as ym,
         sum(plan_min) as final_plan_min, sum(actual_min) as actual_min, sum(variance_min) as variance_min,
         sum(case when variance_min - allowed_over_min > 0 then variance_min - allowed_over_min else 0 end) as ops_over_min,
         count(*) filter (where is_exception) as exception_days,
         count(*) filter (where is_exception and reason_entered) as reason_entered_days
  from mart_shift_variance_facility_daily group by 1, 2
),
cost as ( -- 人件費モデルv2: アルバイト=時間差×宿の標準時給 / スポット=時給差のみ / 正社員=0(固定) / 残業廃止
  select v.facility, date_trunc('month', v.work_date)::date as ym,
    round(sum(
      case
        when coalesce(ds.is_spot, false) then
          case when p.spot_wage_kind = '時給' then v.variance_min / 60.0 * coalesce(p.spot_wage_amount, 0) else 0 end
        when ds.employment_type = 'アルバイト' then v.variance_min / 60.0 * coalesce(lr.hourly_wage, 0)
        else 0
      end
    )) as cost_impact_hourly,
    0::numeric as cost_impact_monthly_ot
  from mart_shift_variance_staff_daily v
  join dim_staff ds on ds.staff_code = v.staff_code
  left join dim_labor_rate lr on lr.facility = v.facility
  left join raw_shift_plan p on p.staff_code = v.staff_code and p.work_facility = v.facility and p.work_date = v.work_date
  group by 1, 2
),
revisions as (
  select work_facility as facility, date_trunc('month', work_date)::date as ym, count(*) as revision_count
  from raw_shift_plan_log where operation in ('UPDATE','DELETE') group by 1, 2
)
select
  f.facility, f.ym,
  b.baseline_min, f.final_plan_min, f.actual_min,
  f.final_plan_min - b.baseline_min as revision_min,
  f.variance_min,
  f.actual_min - b.baseline_min     as baseline_variance_min,
  f.ops_over_min, c.cost_impact_hourly, c.cost_impact_monthly_ot,
  r.revision_count, f.exception_days, f.reason_entered_days
from final_actual f
left join baseline b on b.facility = f.facility and b.ym = f.ym
left join cost c on c.facility = f.facility and c.ym = f.ym
left join revisions r on r.facility = f.facility and r.ym = f.ym
where public.can_access_facility(f.facility);   -- ★自前ゲート
alter view mart_shift_variance_monthly set (security_invoker = off);

-- ---- 6) 念のため: invoker=off ビューへの anon の SELECT 権限を剥奪（多重防御） ----
revoke select on mart_labor_cost_monthly     from anon;
revoke select on mart_shift_variance_monthly from anon;

-- ---- 動作確認（実行後に流す） ----
-- 1) invoker 設定の一覧（off は mart_labor_cost_monthly / mart_shift_variance_monthly / mart_meal_monthly のみのはず）
-- select viewname, (select option_value from pg_options_to_table(c.reloptions) o where option_name='security_invoker') as invoker
--   from pg_views v join pg_class c on c.relname = v.viewname
--  where schemaname='public' and viewname like 'mart_%' order by 1;
-- 2) anon で 4ビューが 0件になること（アプリの anon キーで REST を叩くか、SQL Editor で: set role anon; select count(*) from mart_occupancy_monthly; reset role;）
