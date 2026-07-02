-- ============================================================
--  シフト・労務管理 v1  マイグレーション（T01）  ※冪等・何度でも実行可
--  Supabase SQL Editor に全文貼付→Run。既存テーブルは複製せずALTERのみ。
--  正本: docs/ddl_shift_labor_v1.sql（本ファイルはそれを冪等化した実行用）
-- ============================================================

-- ---- B. dim_staff 賃金項目（ALTER） ----
alter table dim_staff
  add column if not exists wage_type text,
  add column if not exists hourly_wage numeric,
  add column if not exists monthly_salary numeric,
  add column if not exists deemed_ot_hours numeric not null default 0,
  add column if not exists contracted_monthly_hours numeric,
  add column if not exists is_spot boolean not null default false;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'dim_staff_wage_type_chk') then
    alter table dim_staff add constraint dim_staff_wage_type_chk
      check (wage_type is null or wage_type in ('時給','月給'));
  end if;
end $$;

-- ---- B-2. raw_attendance_daily 由来列（ALTER。既存行=KOT / スポット手入力=manual） ----
alter table raw_attendance_daily
  add column if not exists source text not null default 'KOT';

-- ---- C. 役割マスタ ----
create table if not exists dim_role (
  role_id     bigint generated always as identity primary key,
  role_name   text not null unique,
  color       text,
  sort_order  int not null default 0,
  is_active   boolean not null default true
);

-- ---- D. 勤務・休日パターンマスタ ----
create table if not exists dim_shift_pattern (
  pattern_id      bigint generated always as identity primary key,
  pattern_type    text not null check (pattern_type in ('勤務','休日')),
  name            text not null,
  start_time      time,
  end_time        time,
  break_minutes   int not null default 0,
  default_role_id bigint references dim_role(role_id),
  is_paid         boolean not null default false,
  color           text,
  sort_order      int not null default 0,
  is_active       boolean not null default true,
  facility        text
);
-- 休日パターン初期（重複投入しない）
insert into dim_shift_pattern (pattern_type, name, is_paid, color, sort_order)
select v.* from (values
    ('休日','公休', false, '#B4B2A9', 90),
    ('休日','有給', true,  '#E24B4A', 91)
  ) as v(pattern_type,name,is_paid,color,sort_order)
where not exists (
  select 1 from dim_shift_pattern d where d.pattern_type='休日' and d.name=v.name
);

-- ---- E. シフト計画ヘッダ ＝「予」 ----
create table if not exists raw_shift_plan (
  shift_id        bigint generated always as identity primary key,
  staff_code      text not null references dim_staff(staff_code),
  work_facility   text not null,
  work_date       date not null,
  pattern_id      bigint references dim_shift_pattern(pattern_id),
  planned_minutes int not null default 0,
  note            text,
  updated_at      timestamptz not null default now(),
  unique (staff_code, work_facility, work_date)
);
create index if not exists idx_shift_plan_fac_date on raw_shift_plan (work_facility, work_date);

-- ---- F. 役割セグメント ＝「予」の内訳 ----
create table if not exists raw_shift_segment (
  segment_id    bigint generated always as identity primary key,
  shift_id      bigint not null references raw_shift_plan(shift_id) on delete cascade,
  seq           int not null,
  role_id       bigint not null references dim_role(role_id),
  start_time    time not null,
  end_time      time not null,
  break_minutes int not null default 0,
  work_minutes  int not null,
  unique (shift_id, seq)
);

-- ---- G. 稼働前提の手入力（オンハンド/予測/メモ） ----
create table if not exists raw_daily_plan_context (
  facility       text not null,
  work_date      date not null,
  onhand_rooms   int,
  forecast_rooms int,
  memo           text,
  updated_at     timestamptz not null default now(),
  primary key (facility, work_date)
);

-- ---- RLS（新規テーブル。authenticated に許可。既存BIと同方式） ----
do $$
declare t text;
begin
  foreach t in array array['dim_role','dim_shift_pattern','raw_shift_plan','raw_shift_segment','raw_daily_plan_context']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists %I on %I', t||'_all_authenticated', t);
    execute format('create policy %I on %I for all to authenticated using (true) with check (true)', t||'_all_authenticated', t);
  end loop;
end $$;

-- ---- H. 予実ビュー（従業員×日付×施設） ----
create or replace view mart_shift_variance as
select
  coalesce(p.staff_code,    a.staff_code)     as staff_code,
  coalesce(p.work_facility, a.work_facility)  as work_facility,
  coalesce(p.work_date,     a.work_date)      as work_date,
  p.planned_minutes                           as plan_minutes,
  a.total_work_min                            as actual_minutes,
  coalesce(a.total_work_min,0) - coalesce(p.planned_minutes,0) as variance_minutes
from raw_shift_plan p
full outer join raw_attendance_daily a
  on  p.staff_code    = a.staff_code
  and p.work_facility = a.work_facility
  and p.work_date     = a.work_date;

-- ---- I. 人件費ビュー（実績。従業員×施設×月） ----
create or replace view mart_labor_cost_actual as
with h as (
  select staff_code, work_facility,
         date_trunc('month', work_date)::date as ym,
         sum(total_work_min)/60.0 as hours
  from raw_attendance_daily
  group by 1,2,3
)
select
  h.staff_code, h.work_facility, h.ym, h.hours,
  s.wage_type, s.is_spot,
  case
    when s.wage_type='時給' then round(h.hours * s.hourly_wage)
    when s.wage_type='月給' then s.monthly_salary
      + round(greatest(0, h.hours - s.contracted_monthly_hours - s.deemed_ot_hours)
              * (s.monthly_salary / nullif(s.contracted_monthly_hours,0)) * 1.25)
    else round(h.hours * coalesce(s.hourly_wage,0))
  end as labor_cost,
  case when s.wage_type='月給'
    then round(greatest(0, h.hours - s.contracted_monthly_hours - s.deemed_ot_hours)
               * (s.monthly_salary / nullif(s.contracted_monthly_hours,0)) * 1.25)
    else 0 end as ot_pay_over_deemed,
  case when s.is_spot then h.hours else 0 end as spot_hours
from h
join dim_staff s on s.staff_code = h.staff_code;

-- ---- I-2. 人件費 施設×月ロールアップ ＝ 生産性KPI供給（T13） ----
create or replace view mart_labor_cost_monthly as
select
  work_facility                as facility,
  to_char(ym, 'YYYY-MM')       as month,
  sum(labor_cost)              as labor_cost,
  sum(ot_pay_over_deemed)      as deemed_ot_excess_pay,
  sum(spot_hours)              as spot_hours
from mart_labor_cost_actual
group by work_facility, ym;

-- ---- J. 人件費ビュー（計画） ----
create or replace view mart_labor_cost_plan as
with h as (
  select staff_code, work_facility,
         date_trunc('month', work_date)::date as ym,
         sum(planned_minutes)/60.0 as hours
  from raw_shift_plan
  group by 1,2,3
)
select
  h.staff_code, h.work_facility, h.ym, h.hours, s.wage_type, s.is_spot,
  case
    when s.wage_type='時給' then round(h.hours * s.hourly_wage)
    when s.wage_type='月給' then s.monthly_salary
      + round(greatest(0, h.hours - s.contracted_monthly_hours - s.deemed_ot_hours)
              * (s.monthly_salary / nullif(s.contracted_monthly_hours,0)) * 1.25)
    else round(h.hours * coalesce(s.hourly_wage,0))
  end as labor_cost_plan
from h
join dim_staff s on s.staff_code = h.staff_code;

-- ---- K. 稼働前提ビュー（予算＋手入力）  budget_daily: facility / date ----
create or replace view mart_daily_plan_context as
select
  b.facility,
  b.date          as work_date,
  b.rooms_sold    as budget_rooms,
  b.guests        as budget_guests,
  c.onhand_rooms,
  c.forecast_rooms,
  c.memo
from budget_daily b
left join raw_daily_plan_context c
  on c.facility = b.facility
 and c.work_date = b.date;
