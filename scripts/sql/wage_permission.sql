-- ============================================================
--  給与閲覧権限＋賃金テーブル分離＋人件費ビュー修正（フェーズ1）
--  Supabase SQL Editor で実行（冪等）。rls_facility.sql 実行後が前提。
--  内容:
--   1) app_user.can_view_wage（給与閲覧権限フラグ）
--   2) 賃金列を dim_staff → dim_staff_wage に分離（行RLSで給与を保護）
--   3) mart_labor_cost_actual/plan: 給与権限者のみ＋月給の二重計上/NULL脱落を修正
--   4) mart_labor_cost_monthly: 施設×月合計（施設メンバー全員可・T13のKPI供給元）
-- ============================================================

-- ---- 1) 給与閲覧権限フラグ ----
alter table app_user add column if not exists can_view_wage boolean not null default false;
update app_user set can_view_wage = true where role = 'admin';  -- adminは常に可（関数側でも保証）

create or replace function public.can_view_wage() returns boolean
language sql stable security definer set search_path = public as
$$ select exists (select 1 from app_user
                  where user_id = auth.uid() and (role = 'admin' or can_view_wage)) $$;
grant execute on function public.can_view_wage() to authenticated;

-- ---- 2) 賃金テーブル分離 ----
create table if not exists dim_staff_wage (
  staff_code TEXT primary key references dim_staff(staff_code) on delete cascade,
  wage_type TEXT check (wage_type is null or wage_type in ('時給','月給')),
  hourly_wage NUMERIC,
  monthly_salary NUMERIC,
  deemed_ot_hours NUMERIC not null default 0,
  contracted_monthly_hours NUMERIC,
  updated_at TIMESTAMPTZ default now()
);

-- dim_staff に旧賃金列が残っていればデータを移送（初回のみ実行される）
do $$
begin
  if exists (select 1 from information_schema.columns
             where table_name = 'dim_staff' and column_name = 'wage_type') then
    insert into dim_staff_wage (staff_code, wage_type, hourly_wage, monthly_salary, deemed_ot_hours, contracted_monthly_hours)
    select staff_code, wage_type, hourly_wage, monthly_salary, coalesce(deemed_ot_hours, 0), contracted_monthly_hours
    from dim_staff
    where wage_type is not null or hourly_wage is not null or monthly_salary is not null
    on conflict (staff_code) do nothing;
  end if;
end $$;

-- RLS: 閲覧/変更 = 給与権限 かつ 施設アクセス可。追加(INSERT) = 施設アクセス可のみ
--（総支配人が給与権限なしでもスポット時給を登録できる。読み返しは権限者のみ）
alter table dim_staff_wage enable row level security;
do $$
declare pol record;
begin
  for pol in select policyname from pg_policies where schemaname = 'public' and tablename = 'dim_staff_wage' loop
    execute format('drop policy %I on dim_staff_wage', pol.policyname);
  end loop;
end $$;
create policy wage_select on dim_staff_wage for select to authenticated
  using (public.can_view_wage() and exists (
    select 1 from dim_staff s where s.staff_code = dim_staff_wage.staff_code
      and public.can_access_facility(s.home_facility)));
create policy wage_insert on dim_staff_wage for insert to authenticated
  with check (exists (
    select 1 from dim_staff s where s.staff_code = dim_staff_wage.staff_code
      and public.can_access_facility(s.home_facility)));
create policy wage_update on dim_staff_wage for update to authenticated
  using (public.can_view_wage() and exists (
    select 1 from dim_staff s where s.staff_code = dim_staff_wage.staff_code
      and public.can_access_facility(s.home_facility)))
  with check (public.can_view_wage() and exists (
    select 1 from dim_staff s where s.staff_code = dim_staff_wage.staff_code
      and public.can_access_facility(s.home_facility)));
create policy wage_delete on dim_staff_wage for delete to authenticated
  using (public.can_view_wage() and exists (
    select 1 from dim_staff s where s.staff_code = dim_staff_wage.staff_code
      and public.can_access_facility(s.home_facility)));

-- ---- 3) 人件費ビュー再作成（賃金は dim_staff_wage 参照） ----
--  修正点:
--   a) 月給の base は本務施設(home_facility)にのみ計上（クロス施設の二重計上を解消）
--   b) 残業判定は 従業員×月の全施設合計時間 で行う（施設分割による過少判定を解消）
--   c) contracted_monthly_hours 未設定の月給者は 残業0・base のみ（NULL脱落を解消）
--  給与権限者のみ閲覧可（個人単位の人件費＝実質給与情報のため）
drop view if exists mart_labor_cost_monthly;
drop view if exists mart_labor_cost_actual;
drop view if exists mart_labor_cost_plan;

create view mart_labor_cost_actual
with (security_invoker = on) as
with h as (  -- 従業員×施設×月の実働
  select staff_code, work_facility,
         date_trunc('month', work_date)::date as ym,
         sum(total_work_min)/60.0 as hours
  from raw_attendance_daily
  group by 1,2,3
),
tot as (  -- 従業員×月の全施設合計（残業判定用）
  select staff_code, ym, sum(hours) as total_hours from h group by 1,2
)
select
  h.staff_code, h.work_facility, h.ym, h.hours,
  w.wage_type, coalesce(s.is_spot, false) as is_spot,
  case
    when w.wage_type = '時給' then round(h.hours * coalesce(w.hourly_wage, 0))
    when w.wage_type = '月給' then
      -- base は本務施設の行にのみ計上。残業代は全施設合計時間で判定し本務施設に計上
      case when h.work_facility = s.home_facility then
        coalesce(w.monthly_salary, 0)
        + round(greatest(0, t.total_hours - coalesce(w.contracted_monthly_hours, t.total_hours) - coalesce(w.deemed_ot_hours, 0))
                * (coalesce(w.monthly_salary, 0) / nullif(w.contracted_monthly_hours, 0)) * 1.25)
      else 0 end
    else round(h.hours * coalesce(w.hourly_wage, 0))
  end as labor_cost,
  case when w.wage_type = '月給' and h.work_facility = s.home_facility then
    coalesce(round(greatest(0, t.total_hours - coalesce(w.contracted_monthly_hours, t.total_hours) - coalesce(w.deemed_ot_hours, 0))
                   * (coalesce(w.monthly_salary, 0) / nullif(w.contracted_monthly_hours, 0)) * 1.25), 0)
  else 0 end as ot_pay_over_deemed,
  case when coalesce(s.is_spot, false) then h.hours else 0 end as spot_hours
from h
join tot t on t.staff_code = h.staff_code and t.ym = h.ym
join dim_staff s on s.staff_code = h.staff_code
left join dim_staff_wage w on w.staff_code = h.staff_code
where public.can_view_wage();

create view mart_labor_cost_plan
with (security_invoker = on) as
with h as (
  select staff_code, work_facility,
         date_trunc('month', work_date)::date as ym,
         sum(planned_minutes)/60.0 as hours
  from raw_shift_plan
  group by 1,2,3
),
tot as (
  select staff_code, ym, sum(hours) as total_hours from h group by 1,2
)
select
  h.staff_code, h.work_facility, h.ym, h.hours,
  w.wage_type, coalesce(s.is_spot, false) as is_spot,
  case
    when w.wage_type = '時給' then round(h.hours * coalesce(w.hourly_wage, 0))
    when w.wage_type = '月給' then
      case when h.work_facility = s.home_facility then
        coalesce(w.monthly_salary, 0)
        + round(greatest(0, t.total_hours - coalesce(w.contracted_monthly_hours, t.total_hours) - coalesce(w.deemed_ot_hours, 0))
                * (coalesce(w.monthly_salary, 0) / nullif(w.contracted_monthly_hours, 0)) * 1.25)
      else 0 end
    else round(h.hours * coalesce(w.hourly_wage, 0))
  end as labor_cost_plan
from h
join tot t on t.staff_code = h.staff_code and t.ym = h.ym
join dim_staff s on s.staff_code = h.staff_code
left join dim_staff_wage w on w.staff_code = h.staff_code
where public.can_view_wage();

-- ---- 4) 施設×月ロールアップ（T13のKPI供給元） ----
--  施設合計の人件費・みなし残業超・派遣時間は PL と同じ「施設集計値」なので、
--  給与権限は不要（施設メンバーなら閲覧可）。security_invoker はオフにし、
--  ビュー内で施設アクセスを自前ゲート（is_admin or user_facility）。
create view mart_labor_cost_monthly as
with h as (
  select staff_code, work_facility,
         date_trunc('month', work_date)::date as ym,
         sum(total_work_min)/60.0 as hours
  from raw_attendance_daily
  group by 1,2,3
),
tot as (
  select staff_code, ym, sum(hours) as total_hours from h group by 1,2
),
cost as (
  select
    h.work_facility, h.ym,
    case
      when w.wage_type = '時給' then round(h.hours * coalesce(w.hourly_wage, 0))
      when w.wage_type = '月給' then
        case when h.work_facility = s.home_facility then
          coalesce(w.monthly_salary, 0)
          + round(greatest(0, t.total_hours - coalesce(w.contracted_monthly_hours, t.total_hours) - coalesce(w.deemed_ot_hours, 0))
                  * (coalesce(w.monthly_salary, 0) / nullif(w.contracted_monthly_hours, 0)) * 1.25)
        else 0 end
      else round(h.hours * coalesce(w.hourly_wage, 0))
    end as labor_cost,
    case when w.wage_type = '月給' and h.work_facility = s.home_facility then
      coalesce(round(greatest(0, t.total_hours - coalesce(w.contracted_monthly_hours, t.total_hours) - coalesce(w.deemed_ot_hours, 0))
                     * (coalesce(w.monthly_salary, 0) / nullif(w.contracted_monthly_hours, 0)) * 1.25), 0)
    else 0 end as ot_pay_over_deemed,
    case when coalesce(s.is_spot, false) then h.hours else 0 end as spot_hours
  from h
  join tot t on t.staff_code = h.staff_code and t.ym = h.ym
  join dim_staff s on s.staff_code = h.staff_code
  left join dim_staff_wage w on w.staff_code = h.staff_code
)
select
  work_facility               as facility,
  to_char(ym, 'YYYY-MM')      as month,
  sum(labor_cost)             as labor_cost,
  sum(ot_pay_over_deemed)     as deemed_ot_excess_pay,
  sum(spot_hours)             as spot_hours
from cost
where public.is_admin()
   or work_facility in (select facility from user_facility where user_id = auth.uid())
group by work_facility, ym;

alter view mart_labor_cost_monthly set (security_invoker = off);  -- 自前ゲートのため明示off

-- ---- 5) dim_staff から旧賃金列を削除（給与の直読み経路を遮断。is_spot は残す） ----
alter table dim_staff
  drop column if exists wage_type,
  drop column if exists hourly_wage,
  drop column if exists monthly_salary,
  drop column if exists deemed_ot_hours,
  drop column if exists contracted_monthly_hours;

-- ---- 動作確認 ----
-- select * from dim_staff_wage limit 3;              -- adminなら見える
-- select * from mart_labor_cost_monthly limit 3;      -- 施設メンバーなら見える
