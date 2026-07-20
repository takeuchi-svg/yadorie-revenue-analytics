-- ============================================================
--  シフト予実・振り返り機能 v2  実DB調整版（SV01基盤＋予実ビュー群）
--  Supabase SQL Editor で全文 Run（冪等）。ddl_shift_variance_v2.sql を実スキーマに合わせて修正。
--  実DB確認済の調整点:
--   - raw_shift_plan: PK=shift_id / 休日=pattern_id→dim_shift_pattern.pattern_type='休日' / is_spotは無い(dim_staff)
--   - raw_attendance_daily: 計上先=work_facility / 本務=dim_staff.home_facility / HELP=is_help / 残業=overtime_min
--   - 賃金は dim_staff_wage(別表・RLS) → 人件費ビューは invoker=off で施設メンバー可(mart_labor_cost_monthly方式)
--   - 実績客数ソース fact_guests_daily 無し → mart_guests_daily を新設(raw_reservation C/O の人泊)
--   - 計画前提客数 = mart_daily_plan_context.budget_guests（既存）
-- ============================================================

-- ============================================================
--  A. 変更ログ（raw_shift_plan の全変更を自動記録・PK=shift_id）
-- ============================================================
create table if not exists raw_shift_plan_log (
  id            bigint generated always as identity primary key,
  operation     text not null check (operation in ('INSERT','UPDATE','DELETE')),
  shift_id      bigint,
  staff_code    text,
  work_facility text,
  work_date     date,
  old_row       jsonb,
  new_row       jsonb,
  changed_by    uuid,
  changed_at    timestamptz not null default now()
);
create index if not exists idx_shift_plan_log_facility_month on raw_shift_plan_log (work_facility, work_date);

create or replace function trg_log_shift_plan() returns trigger
language plpgsql security definer as $$
begin
  if tg_op = 'INSERT' then
    insert into raw_shift_plan_log (operation, shift_id, staff_code, work_facility, work_date, old_row, new_row, changed_by)
    values ('INSERT', new.shift_id, new.staff_code, new.work_facility, new.work_date, null, to_jsonb(new), auth.uid());
    return new;
  elsif tg_op = 'UPDATE' then
    insert into raw_shift_plan_log (operation, shift_id, staff_code, work_facility, work_date, old_row, new_row, changed_by)
    values ('UPDATE', new.shift_id, new.staff_code, new.work_facility, new.work_date, to_jsonb(old), to_jsonb(new), auth.uid());
    return new;
  else
    insert into raw_shift_plan_log (operation, shift_id, staff_code, work_facility, work_date, old_row, new_row, changed_by)
    values ('DELETE', old.shift_id, old.staff_code, old.work_facility, old.work_date, to_jsonb(old), null, auth.uid());
    return old;
  end if;
end $$;
drop trigger if exists shift_plan_audit on raw_shift_plan;
create trigger shift_plan_audit after insert or update or delete on raw_shift_plan
  for each row execute function trg_log_shift_plan();

-- ============================================================
--  B. 公開イベント ＋ 公開時スナップショット
-- ============================================================
create table if not exists shift_plan_publication (
  id            bigint generated always as identity primary key,
  facility      text not null,
  target_month  date not null,          -- 月初日
  is_baseline   boolean not null,       -- 初回公開=月初版
  published_by  uuid,
  published_at  timestamptz not null default now()
);
create index if not exists idx_publication_facility_month on shift_plan_publication (facility, target_month);

create table if not exists raw_shift_plan_snapshot (
  id              bigint generated always as identity primary key,
  publication_id  bigint not null references shift_plan_publication(id) on delete cascade,
  staff_code      text not null,
  work_facility   text not null,
  work_date       date not null,
  planned_minutes int not null,
  pattern_id      bigint,               -- v1のパターン(FK)
  is_spot         boolean default false,
  snapshot_row    jsonb
);
create index if not exists idx_snapshot_pub on raw_shift_plan_snapshot (publication_id, work_date);

create or replace function publish_shift_plan(p_facility text, p_month date)
returns bigint language plpgsql security definer as $$
declare v_is_baseline boolean; v_pub_id bigint;
begin
  select not exists (select 1 from shift_plan_publication where facility = p_facility and target_month = p_month)
    into v_is_baseline;
  insert into shift_plan_publication (facility, target_month, is_baseline, published_by)
  values (p_facility, p_month, v_is_baseline, auth.uid()) returning id into v_pub_id;

  insert into raw_shift_plan_snapshot (publication_id, staff_code, work_facility, work_date, planned_minutes, pattern_id, is_spot, snapshot_row)
  select v_pub_id, p.staff_code, p.work_facility, p.work_date, p.planned_minutes, p.pattern_id,
         coalesce(ds.is_spot, false), to_jsonb(p)
  from raw_shift_plan p
  left join dim_staff ds on ds.staff_code = p.staff_code
  where p.work_facility = p_facility
    and date_trunc('month', p.work_date)::date = p_month;
  return v_pub_id;
end $$;

-- ============================================================
--  C-0. 実績客数（日次人泊）: raw_reservation C/O を宿泊日展開して集計（新設）
-- ============================================================
create or replace view mart_guests_daily as
select r.facility,
       (r.checkin + gs.n)::date as stay_date,
       sum(coalesce(r.guests_total, 0))::int as guests_actual
from raw_reservation r
cross join lateral generate_series(0, greatest(r.nights, 1) - 1) as gs(n)
where r.status = 'C/O'
group by r.facility, (r.checkin + gs.n)::date;
alter view mart_guests_daily set (security_invoker = on);

-- ============================================================
--  C. 標準人時係数（分/人泊）
-- ============================================================
create table if not exists dim_labor_standard (
  id                bigint generated always as identity primary key,
  facility          text not null,
  minutes_per_guest numeric not null,
  source            text not null check (source in ('auto','manual')),
  effective_from    date not null default current_date,
  note              text,
  updated_by        uuid,
  updated_at        timestamptz not null default now()
);
create index if not exists idx_labor_standard_facility on dim_labor_standard (facility, effective_from desc);

-- 自動算出: 直近6ヶ月の 日次労働合計÷実績客数 の施設別中央値
create or replace view mart_labor_standard_auto as
with daily as (
  select a.work_facility as facility, a.work_date,
         sum(a.total_work_min) as work_min,
         max(g.guests_actual)  as guests
  from raw_attendance_daily a
  join mart_guests_daily g on g.facility = a.work_facility and g.stay_date = a.work_date
  where a.work_date >= (current_date - interval '6 months')
  group by 1, 2
)
select facility,
       round((percentile_cont(0.5) within group (order by work_min::numeric / nullif(guests, 0)))::numeric, 1) as minutes_per_guest_auto,
       count(*) as sample_days
from daily where guests > 0
group by facility;
alter view mart_labor_standard_auto set (security_invoker = on);

-- 有効係数（手動優先）。手動は施設ごと最新1件を先に集約し、自動と FULL OUTER JOIN（LATERAL不可のため）
create or replace view mart_labor_standard_effective as
with man as (
  select distinct on (facility) facility, minutes_per_guest
  from dim_labor_standard where source = 'manual'
  order by facility, effective_from desc
)
select coalesce(m.facility, a.facility) as facility,
       coalesce(m.minutes_per_guest, a.minutes_per_guest_auto) as minutes_per_guest,
       case when m.facility is not null then 'manual' else 'auto' end as source
from mart_labor_standard_auto a
full outer join man m on m.facility = a.facility;
alter view mart_labor_standard_effective set (security_invoker = on);

-- ============================================================
--  D. 理由マスタ ＋ 理由入力（施設×日）
-- ============================================================
create table if not exists dim_variance_reason (
  reason_code   text primary key,
  label         text not null,
  category      text not null,
  display_order int not null default 100,
  is_active     boolean not null default true
);
insert into dim_variance_reason (reason_code, label, category, display_order) values
  ('DEMAND_GROUP','急な団体・客数増対応','需要変動',10),
  ('DEMAND_DROP','キャンセル・客数減','需要変動',20),
  ('ABSENCE_SICK','体調不良による欠勤','欠員対応',30),
  ('ABSENCE_OTHER','その他欠勤・穴埋め','欠員対応',40),
  ('OPS_CLEANING','清掃遅延','運用',50),
  ('OPS_TROUBLE','トラブル・クレーム対応','運用',60),
  ('OPS_HANDOVER','申し送り・段取り不足','運用',70),
  ('TRAINING','教育・OJT','教育',80),
  ('EVENT','イベント・催事準備','イベント',90),
  ('OTHER','その他','その他',100)
on conflict (reason_code) do nothing;

create table if not exists raw_shift_variance_note (
  id           bigint generated always as identity primary key,
  facility     text not null,
  work_date    date not null,
  reason_codes text[] not null,
  note         text,
  input_by     uuid,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (facility, work_date)
);

-- ============================================================
--  E. 予実ビュー: 従業員×日（最終版計画 vs 実績・自動分類）
-- ============================================================
create or replace view mart_shift_variance_staff_daily as
with p as (
  select sp.staff_code, sp.work_facility as facility, sp.work_date,
         sum(sp.planned_minutes) as plan_min,
         bool_or(pt.pattern_type = '休日') as is_holiday_pattern
  from raw_shift_plan sp
  left join dim_shift_pattern pt on pt.pattern_id = sp.pattern_id
  group by 1, 2, 3
),
a as (
  select att.staff_code, att.work_facility as facility, att.work_date,
         sum(att.total_work_min) as actual_min,
         sum(att.overtime_min)   as overtime_min,   -- 残業=overtime_min のみ
         bool_or(coalesce(att.is_help, false)) as is_help
  from raw_attendance_daily att
  group by 1, 2, 3
)
select
  coalesce(p.staff_code, a.staff_code) as staff_code,
  coalesce(p.facility, a.facility)     as facility,
  coalesce(p.work_date, a.work_date)   as work_date,
  coalesce(p.plan_min, 0)              as plan_min,
  coalesce(a.actual_min, 0)            as actual_min,
  coalesce(a.actual_min, 0) - coalesce(p.plan_min, 0) as variance_min,   -- 計画超過(+)/未達(-)
  coalesce(a.overtime_min, 0)          as overtime_min,                   -- 労務上の残業（併記用）
  case
    when coalesce(p.plan_min,0) > 0 and coalesce(a.actual_min,0) = 0 then 'ABSENCE'
    when coalesce(p.plan_min,0) = 0 and coalesce(a.actual_min,0) > 0 and coalesce(ds.is_spot,false) then 'SPOT_ADD'
    when coalesce(p.plan_min,0) = 0 and coalesce(a.actual_min,0) > 0
         and (coalesce(a.is_help,false) or (a.facility is distinct from ds.home_facility)) then 'HELP'
    when coalesce(p.plan_min,0) = 0 and coalesce(a.actual_min,0) > 0 and coalesce(p.is_holiday_pattern,false) then 'HOLIDAY_WORK'
    when coalesce(p.plan_min,0) = 0 and coalesce(a.actual_min,0) > 0 then 'UNPLANNED'
    when abs(coalesce(a.actual_min,0) - coalesce(p.plan_min,0)) <= 15 then 'ON_PLAN'  -- 許容誤差15分
    when coalesce(a.actual_min,0) > coalesce(p.plan_min,0) then 'OVER'
    else 'UNDER'
  end as variance_type
from p
full outer join a on a.staff_code = p.staff_code and a.facility = p.facility and a.work_date = p.work_date
left join dim_staff ds on ds.staff_code = coalesce(p.staff_code, a.staff_code);
alter view mart_shift_variance_staff_daily set (security_invoker = on);

-- ============================================================
--  F. 予実ビュー: 施設×日（需要調整・例外フラグ・理由JOIN）
-- ============================================================
create or replace view mart_shift_variance_facility_daily as
with v as (
  select facility, work_date,
         sum(plan_min) as plan_min, sum(actual_min) as actual_min,
         sum(variance_min) as variance_min, sum(overtime_min) as overtime_min,
         count(*) filter (where variance_type = 'ABSENCE')   as cnt_absence,
         count(*) filter (where variance_type = 'UNPLANNED') as cnt_unplanned,
         count(*) filter (where variance_type = 'SPOT_ADD')  as cnt_spot,
         count(*) filter (where variance_type = 'HELP')      as cnt_help
  from mart_shift_variance_staff_daily
  group by 1, 2
),
g as (
  select c.facility, c.work_date, c.budget_guests as guests_plan, ga.guests_actual
  from mart_daily_plan_context c
  left join mart_guests_daily ga on ga.facility = c.facility and ga.stay_date = c.work_date
)
select
  v.facility, v.work_date,
  extract(isodow from v.work_date) as weekday,
  v.plan_min, v.actual_min, v.variance_min, v.overtime_min,
  g.guests_plan, g.guests_actual, s.minutes_per_guest,
  greatest(0, coalesce(g.guests_actual,0) - coalesce(g.guests_plan,0)) * coalesce(s.minutes_per_guest,0) as allowed_over_min,
  v.variance_min - least(greatest(v.variance_min,0),
      greatest(0, coalesce(g.guests_actual,0) - coalesce(g.guests_plan,0)) * coalesce(s.minutes_per_guest,0)) as adjusted_variance_min,
  (coalesce(g.guests_actual,0) < coalesce(g.guests_plan,0) and v.variance_min >= 0) as flag_no_flex_down,
  v.cnt_absence, v.cnt_unplanned, v.cnt_spot, v.cnt_help,
  n.reason_codes, n.note, (n.id is not null) as reason_entered,
  abs(v.variance_min - least(greatest(v.variance_min,0),
      greatest(0, coalesce(g.guests_actual,0) - coalesce(g.guests_plan,0)) * coalesce(s.minutes_per_guest,0))) >= 300 as is_exception
from v
left join g on g.facility = v.facility and g.work_date = v.work_date
left join mart_labor_standard_effective s on s.facility = v.facility
left join raw_shift_variance_note n on n.facility = v.facility and n.work_date = v.work_date;
alter view mart_shift_variance_facility_daily set (security_invoker = on);

-- ============================================================
--  G. 予実ビュー: 施設×月（3時点予実＋人件費影響）  ※人件費=賃金由来 → invoker=off(施設メンバー可)
-- ============================================================
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
cost as ( -- v1賃金ロジック流用: 賃金は dim_staff_wage、時給/スポット=差×時給、月給=残業(overtime)超過×月給按分×1.25
  select v.facility, date_trunc('month', v.work_date)::date as ym,
    round(sum(case when (w.wage_type = '時給' or coalesce(ds.is_spot,false))
      then v.variance_min / 60.0 * coalesce(w.hourly_wage, 0) else 0 end)) as cost_impact_hourly,
    round(sum(case when w.wage_type = '月給'
      then greatest(0, v.overtime_min) / 60.0 * (w.monthly_salary / nullif(w.contracted_monthly_hours, 0)) * 1.25
      else 0 end)) as cost_impact_monthly_ot
  from mart_shift_variance_staff_daily v
  join dim_staff ds on ds.staff_code = v.staff_code
  left join dim_staff_wage w on w.staff_code = v.staff_code
  group by 1, 2
),
revisions as (
  select work_facility as facility, date_trunc('month', work_date)::date as ym, count(*) as revision_count
  from raw_shift_plan_log where operation in ('UPDATE','DELETE') group by 1, 2
)
select
  f.facility, f.ym,
  b.baseline_min, f.final_plan_min, f.actual_min,
  f.final_plan_min - b.baseline_min as revision_min,      -- A.月中修正量
  f.variance_min,                                          -- B.当日運用差
  f.actual_min - b.baseline_min     as baseline_variance_min, -- C.月初計画精度
  f.ops_over_min, c.cost_impact_hourly, c.cost_impact_monthly_ot,
  r.revision_count, f.exception_days, f.reason_entered_days
from final_actual f
left join baseline b on b.facility = f.facility and b.ym = f.ym
left join cost c on c.facility = f.facility and c.ym = f.ym
left join revisions r on r.facility = f.facility and r.ym = f.ym;
-- 賃金由来のため invoker=off（定義者権限で集計。施設×月合計は施設メンバー可・mart_labor_cost_monthly と同方式）
alter view mart_shift_variance_monthly set (security_invoker = off);

-- ============================================================
--  H. 予実ビュー: 曜日別
-- ============================================================
create or replace view mart_shift_variance_weekday as
select facility, date_trunc('month', work_date)::date as ym, weekday,
       round(avg(variance_min)) as avg_variance_min,
       round(avg(adjusted_variance_min)) as avg_adjusted_variance_min,
       count(*) as days
from mart_shift_variance_facility_daily group by 1, 2, 3;
alter view mart_shift_variance_weekday set (security_invoker = on);

-- ============================================================
--  I. 予実ビュー: 雇用区分・スポット別（賃金非依存: dim_staff.is_monthly_salary/is_spot を使用）
-- ============================================================
create or replace view mart_shift_variance_by_emptype as
select v.facility, date_trunc('month', v.work_date)::date as ym,
       case when coalesce(ds.is_spot,false) then 'スポット'
            when coalesce(ds.is_monthly_salary,false) then '月給' else '時給' end as emp_type,
       sum(v.plan_min) as plan_min, sum(v.actual_min) as actual_min, sum(v.variance_min) as variance_min
from mart_shift_variance_staff_daily v
join dim_staff ds on ds.staff_code = v.staff_code
group by 1, 2, 3;
alter view mart_shift_variance_by_emptype set (security_invoker = on);

-- ============================================================
--  RLS（新テーブル。v1の can_access_facility 方式）
-- ============================================================
do $$
declare rec record; pol record;
begin
  -- (テーブル名, 施設カラム名) の対で施設スコープ RLS を張る
  for rec in select * from (values
    ('raw_shift_plan_log','work_facility'), ('raw_shift_plan_snapshot','work_facility'),
    ('shift_plan_publication','facility'), ('dim_labor_standard','facility'), ('raw_shift_variance_note','facility')
  ) as v(tbl, col) loop
    execute format('alter table %I enable row level security', rec.tbl);
    for pol in select policyname from pg_policies where schemaname='public' and tablename=rec.tbl loop
      execute format('drop policy %I on %I', pol.policyname, rec.tbl);
    end loop;
    execute format('create policy %I on %I for all to authenticated using (public.can_access_facility(%I)) with check (public.can_access_facility(%I))',
      rec.tbl||'_facility_scope', rec.tbl, rec.col, rec.col);
  end loop;
end $$;

-- 理由マスタ（全員read / adminのみwrite）
alter table dim_variance_reason enable row level security;
drop policy if exists dim_variance_reason_read on dim_variance_reason;
drop policy if exists dim_variance_reason_write on dim_variance_reason;
create policy dim_variance_reason_read on dim_variance_reason for select to authenticated using (true);
create policy dim_variance_reason_write on dim_variance_reason for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- 確認:
--   select * from mart_shift_variance_facility_daily where facility='FRY' order by work_date desc limit 20;
--   select * from mart_shift_variance_monthly where facility='FRY' order by ym desc;
-- ※ rls_facility.sql の mart_ 一括 invoker=on 設定から mart_shift_variance_monthly を除外すること（別途パッチ）。
