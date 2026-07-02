-- ============================================================
--  YADORIE シフト・労務管理システム  確定DDL  (v1)
--  対象: PostgreSQL / Supabase（売上分析・生産性KPIと同一DB）
--  方針: 既存テーブルは再利用し、新規/変更のみを定義する。
--        施設キーは work_facility (TEXT / BIコード) = dim_facility_mapping.facility に統一。
--        従業員キーは staff_code (TEXT) = KOTコードを背骨とする。
--        時間は分(整数)で保持。予実は 従業員×日付×施設 の粒度。
-- ============================================================


-- ============================================================
--  A. 既存・再利用（このファイルでは定義しない。参照のみ）
-- ============================================================
-- dim_staff(
--   staff_code TEXT PK, name, employment_type, is_monthly_salary, home_facility, ...
-- )                                             -- 従業員マスタ（KOT名寄せ済み）
-- raw_attendance_daily(
--   id BIGSERIAL PK, staff_code, work_date, work_facility,
--   clock_in, clock_out, break_min, total_work_min, ..., source
-- )                                             -- 実績（KOT日別取込）＝「実」
-- dim_facility_mapping(
--   attendance_code PK, attendance_name, facility, is_facility
-- )                                             -- 施設マッピング（facility=BIコード）
-- budget_daily(
--   id, facility, fiscal_year, date, rooms_sold, guests, occ, inventory,
--   companion, guest_unit, room_unit, *_revenue..., event_note, created_at
-- )                                             -- 日別予算（稼働室・宿泊人数）
--   ※【T00確認済】施設列=facility(BIコード) / 日付列=date（work_dateではない）。
--     rooms_sold・guests あり。K節ビューは date→work_date に別名付けで結合する。
-- mart_labor_monthly (VIEW)                     -- 生産性KPI（労働時間集計。実在）
--   ※【要確認】mart_productivity ビューは本repoに存在せず、生産性KPIは
--     productivity ページでクライアント側集計。手入力2項目は dim_productivity_manual。
--     → T13(KPI改修)は「productivityページの参照元差し替え＋設定手入力の廃止」で実施する。


-- ============================================================
--  B. 既存 dim_staff への賃金項目追加（ALTER）
-- ============================================================
alter table dim_staff
  add column if not exists wage_type text
      check (wage_type in ('時給','月給')),
  add column if not exists hourly_wage numeric,               -- 時給者の時給
  add column if not exists monthly_salary numeric,            -- 月給者の月給
  add column if not exists deemed_ot_hours numeric not null default 0,  -- 見込み残業時間/月
  add column if not exists contracted_monthly_hours numeric,  -- 月所定労働時間
  add column if not exists is_spot boolean not null default false;      -- 派遣/タイミー等

comment on column dim_staff.deemed_ot_hours is
  '見込み(みなし)残業時間/月。この時間を超えた分のみ残業代を計算する';
comment on column dim_staff.contracted_monthly_hours is
  '月所定労働時間。月給者の残業単価(月給/所定×1.25)の分母';
comment on column dim_staff.is_spot is
  '派遣・タイミー等の短期要員。KOT打刻なし、実働はシフト画面から手入力';
-- ※ 賃金は将来的に改定履歴(effective_from)を別テーブル化するのがv2の理想。
--    v1は dim_staff の現行値を使用する。


-- ============================================================
--  B-2. 既存 raw_attendance_daily への由来列追加（ALTER / T01）
--       実DBには source 列が無く source_file のみのため source を追加。
--       既存行(KOT取込)は 'KOT'。スポット手入力行は 'manual'。
--       is_spot は attendance には持たず、dim_staff.is_spot で判定する。
-- ============================================================
alter table raw_attendance_daily
  add column if not exists source text not null default 'KOT';
comment on column raw_attendance_daily.source is
  '実績の由来。KOT=勤怠取込 / manual=シフト画面のスポット手入力';


-- ============================================================
--  C. 役割マスタ（設定画面で追加・色指定可）
-- ============================================================
create table dim_role (
  role_id     bigint generated always as identity primary key,
  role_name   text not null unique,          -- フロント/客室清掃/朝食/パントリー/夜警/バス…
  color       text,                          -- 任意色（例 '#378ADD'）
  sort_order  int not null default 0,
  is_active   boolean not null default true
);


-- ============================================================
--  D. 勤務・休日パターンマスタ（設定画面で追加・色指定可）
-- ============================================================
create table dim_shift_pattern (
  pattern_id      bigint generated always as identity primary key,
  pattern_type    text not null check (pattern_type in ('勤務','休日')),
  name            text not null,             -- 早番/中番/遅番/ナイト/公休/有給…
  start_time      time,                      -- 休日パターンは NULL
  end_time        time,
  break_minutes   int not null default 0,
  default_role_id bigint references dim_role(role_id),  -- 既定役割（分割しない日に採用）
  is_paid         boolean not null default false,       -- 休日が有給か（有給=true, 公休=false）
  color           text,                       -- 任意色
  sort_order      int not null default 0,
  is_active       boolean not null default true,
  facility        text                        -- NULL=全社共通 / 施設固有も可
);

-- 休日パターン初期データ（デフォルト）
insert into dim_shift_pattern (pattern_type, name, is_paid, color, sort_order)
values ('休日','公休', false, '#B4B2A9', 90),
       ('休日','有給', true,  '#E24B4A', 91);


-- ============================================================
--  E. シフト計画ヘッダ ＝「予」（従業員×日付×施設で1行）
-- ============================================================
create table raw_shift_plan (
  shift_id        bigint generated always as identity primary key,
  staff_code      text not null references dim_staff(staff_code),
  work_facility   text not null,             -- dim_facility_mapping.facility と同一コード
  work_date       date not null,
  pattern_id      bigint references dim_shift_pattern(pattern_id),
  planned_minutes int not null default 0,    -- パターン既定値を初期投入し、以後 編集可
  note            text,
  updated_at      timestamptz not null default now(),
  unique (staff_code, work_facility, work_date)   -- 勤怠のユニークと同一構造
);
create index on raw_shift_plan (work_facility, work_date);


-- ============================================================
--  F. 役割セグメント ＝「予」の内訳（時間帯×役割の分割）
-- ============================================================
create table raw_shift_segment (
  segment_id    bigint generated always as identity primary key,
  shift_id      bigint not null references raw_shift_plan(shift_id) on delete cascade,
  seq           int not null,                -- 同日内の並び順
  role_id       bigint not null references dim_role(role_id),
  start_time    time not null,
  end_time      time not null,
  break_minutes int not null default 0,
  work_minutes  int not null,                -- (end-start)-break を分で保持
  unique (shift_id, seq)
);
-- 運用: 分割しない日は「1シフト=1セグメント」。
--       raw_shift_plan.planned_minutes = そのシフトの全セグメント work_minutes 合計。


-- ============================================================
--  G. 稼働前提の手入力（⑵オンハンド ⑶予測 ＋ メモ）
--     ⑴予算(稼働室・人数)は budget_daily から結合するため保持しない
-- ============================================================
create table raw_daily_plan_context (
  facility       text not null,
  work_date      date not null,
  onhand_rooms   int,                        -- 現状オンハンド稼働室（手入力）
  forecast_rooms int,                        -- 予測稼働室（手入力）
  memo           text,                       -- イベント等のメモ（手入力）
  updated_at     timestamptz not null default now(),
  primary key (facility, work_date)
);


-- ============================================================
--  H. 予実ビュー（従業員×日付×施設）
-- ============================================================
create view mart_shift_variance as
select
  coalesce(p.staff_code,   a.staff_code)     as staff_code,
  coalesce(p.work_facility, a.work_facility)  as work_facility,
  coalesce(p.work_date,    a.work_date)       as work_date,
  p.planned_minutes                           as plan_minutes,     -- 予
  a.total_work_min                            as actual_minutes,   -- 実
  coalesce(a.total_work_min,0) - coalesce(p.planned_minutes,0) as variance_minutes
from raw_shift_plan p
full outer join raw_attendance_daily a
  on  p.staff_code    = a.staff_code
  and p.work_facility = a.work_facility
  and p.work_date     = a.work_date;


-- ============================================================
--  I. 人件費ビュー（実績ベース）＝生産性KPIへ供給する単一ソース
--     時給者: 時給×実働 / 月給者: 月給＋残業代（見込み残業超のみ）
--     残業単価 = 月給 ÷ 月所定 × 1.25（深夜・法定休日割増は含めない）
-- ============================================================
create view mart_labor_cost_actual as
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
    else round(h.hours * coalesce(s.hourly_wage,0))          -- 区分未設定のフォールバック
  end as labor_cost,
  case when s.wage_type='月給'
    then round(greatest(0, h.hours - s.contracted_monthly_hours - s.deemed_ot_hours)
               * (s.monthly_salary / nullif(s.contracted_monthly_hours,0)) * 1.25)
    else 0 end as ot_pay_over_deemed,     -- ＝ 生産性KPI「みなし残業超の残業代」
  case when s.is_spot then h.hours else 0 end as spot_hours  -- ＝ 生産性KPI「派遣・その他労働時間」
from h
join dim_staff s on s.staff_code = h.staff_code;


-- ============================================================
--  I-2. 人件費 施設×月ロールアップ ＝ 生産性KPIへの供給ソース（T13）
--       本repoに mart_productivity ビューは存在しない（生産性はページで
--       クライアント集計）。KPI改修は「productivityページの2指標を
--       本ビューへ差し替え、設定の手入力2項目UIを廃止（備考は残す）」で行う。
-- ============================================================
create view mart_labor_cost_monthly as
select
  work_facility                       as facility,
  to_char(ym, 'YYYY-MM')              as month,
  sum(labor_cost)                     as labor_cost,          -- 実績人件費合計
  sum(ot_pay_over_deemed)             as deemed_ot_excess_pay,-- ＝ みなし残業超の残業代
  sum(spot_hours)                     as spot_hours           -- ＝ 派遣・その他の労働時間(h)
from mart_labor_cost_actual
group by work_facility, ym;


-- ============================================================
--  J. 人件費ビュー（計画ベース）＝シフト画面の予定人件費・月次合計
-- ============================================================
create view mart_labor_cost_plan as
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


-- ============================================================
--  K. 稼働前提ビュー（予算 ＋ 手入力 を1つに）
--     【T00確認済】budget_daily の 施設列=facility / 日付列=date に合わせて調整済み
-- ============================================================
create view mart_daily_plan_context as
select
  b.facility,
  b.date          as work_date,          -- budget_daily は date 列（work_date ではない）
  b.rooms_sold    as budget_rooms,
  b.guests        as budget_guests,
  c.onhand_rooms,
  c.forecast_rooms,
  c.memo
from budget_daily b
left join raw_daily_plan_context c
  on c.facility = b.facility
 and c.work_date = b.date;

-- ============================================================
--  END
-- ============================================================
