-- ============================================================
--  人件費モデル v2  Phase 1（基盤・追加のみ／冪等）
--  Supabase SQL Editor に全文貼付→Run。既存テーブル・ビューは変更しない（安全）。
--
--  目的（個人給与をこの場に持たない）:
--   - 正社員 : 宿×月の「合計額」で持つ（個人給与なし・全社側で毎月入力）
--   - アルバイト : 宿ごとの「標準時給」1本で持つ（個人に紐づけない）
--   - スポット : シフト作成時に「日当/時給＋金額」を都度入力（1回限りの費用）
--   ※残業(割増)計算は廃止。確定人件費は会計(actual_monthly)が正、本モデルは予実の管理推計。
--
--  本Phaseは入力用テーブル/カラムを用意するだけ。人件費マートの載せ替え・
--  dim_staff_wage の撤去は Phase 3（画面で入力できるようになってから）。
-- ============================================================

-- ---- 1) アルバイト標準時給（宿ごと1本・個人非紐付け） ----
create table if not exists dim_labor_rate (
  facility     text primary key,
  hourly_wage  numeric,                    -- この宿のアルバイト標準時給（円/時）
  note         text,
  updated_at   timestamptz not null default now()
);

-- ---- 2) 正社員 人件費（宿×月の合計額・全社側で毎月入力） ----
create table if not exists raw_regular_labor_monthly (
  facility    text not null,
  month       text not null,               -- 'YYYY-MM'
  amount      numeric,                      -- 当月の正社員人件費 合計（円）
  note        text,
  updated_at  timestamptz not null default now(),
  primary key (facility, month)
);

-- ---- 3) スポット賃金（シフト計画のスポット行に都度入力） ----
--   raw_shift_plan は既存。スポット追加時に日当/時給＋金額を持たせる（ALTER・追加のみ）。
alter table raw_shift_plan
  add column if not exists spot_wage_kind   text,     -- '日当' | '時給'（スポット行のみ）
  add column if not exists spot_wage_amount numeric;  -- 日当=1日の額 / 時給=円/時
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'raw_shift_plan_spot_kind_chk') then
    alter table raw_shift_plan add constraint raw_shift_plan_spot_kind_chk
      check (spot_wage_kind is null or spot_wage_kind in ('日当','時給'));
  end if;
end $$;

-- ---- 4) 従業員マスタ: 手動追加の識別（各宿設定から登録できるように） ----
--   'KOT'=勤怠取込由来 / 'manual'=各宿設定で手動追加。勤怠取込は staff_code で突合、
--   無ければ従来どおり自動作成（source は既定 'KOT' のまま）。
alter table dim_staff
  add column if not exists source text not null default 'KOT';

-- ---- RLS（新規テーブル。既存シフト系と同方式＝authenticated 許可。個人給与ではない） ----
do $$
declare t text;
begin
  foreach t in array array['dim_labor_rate','raw_regular_labor_monthly']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists %I on %I', t||'_all_authenticated', t);
    execute format('create policy %I on %I for all to authenticated using (true) with check (true)', t||'_all_authenticated', t);
  end loop;
end $$;

-- 確認:
--   select * from dim_labor_rate;
--   select * from raw_regular_labor_monthly order by facility, month;
--   select column_name from information_schema.columns where table_name='raw_shift_plan' and column_name like 'spot_%';
