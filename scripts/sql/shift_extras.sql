-- ============================================================
--  シフト機能 追加（冪等）: 全社共通「希望休」パターン ＋ 休館日
--  Supabase SQL Editor に全文貼付→Run。
-- ============================================================

-- ---- 1) 全社共通パターンに「希望休」を追加（facility=NULL・休日・無給） ----
insert into dim_shift_pattern (pattern_type, name, is_paid, color, sort_order, facility)
select '休日', '希望休', false, '#E2A03B', 92, null
where not exists (
  select 1 from dim_shift_pattern d where d.facility is null and d.pattern_type = '休日' and d.name = '希望休'
);

-- ---- 2) 休館日フラグ（列をグレー表示。旧館出勤等の記入は可能） ----
alter table raw_daily_plan_context
  add column if not exists is_closed boolean not null default false;

-- ---- 3) mart_daily_plan_context に is_closed を追加（再作成） ----
create or replace view mart_daily_plan_context as
select
  b.facility,
  b.date          as work_date,
  b.rooms_sold    as budget_rooms,
  b.guests        as budget_guests,
  c.onhand_rooms,
  c.forecast_rooms,
  c.memo,
  coalesce(c.is_closed, false) as is_closed
from budget_daily b
left join raw_daily_plan_context c
  on c.facility = b.facility
 and c.work_date = b.date;
-- 再定義で invoker が落ちるため明示（budget_daily/raw_daily_plan_context のRLSを閲覧者権限で継承。棚卸2026-07-21）
alter view mart_daily_plan_context set (security_invoker = on);

-- 確認:
--   select name from dim_shift_pattern where facility is null order by sort_order;
--   select column_name from information_schema.columns where table_name='raw_daily_plan_context' and column_name='is_closed';
