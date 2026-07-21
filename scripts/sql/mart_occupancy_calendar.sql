-- ============================================================
--  稼働率を「全日ベース」でも持つ（第2弾 K20・承認①の修正指示）
--  Supabase SQL Editor で全文 Run（冪等・可逆）
--
--  背景: 現行 mart_occupancy_monthly.occ = 稼働日ベース
--        （販売室数 ÷ (客室数 × 稼働日数=売上実績のある日数)）。
--        克樹さんの指示で「全日ベース（暦日数分母）を主に、稼働日ベースも併存」。
--
--  変更: mart_occupancy_monthly に列 occ_calendar_days を追加（末尾追加＝既存列の意味・順序は不変）。
--        既存 occ 列は保持。参照側（概要/日別/予実ページ・AI）は列名明示のため無影響。
--        mart_ai.mart_occupancy_monthly は select * のため再作成して新列を反映。
--
--  ロールバック: 末尾コメント（occ_calendar_days を除いた元定義で再作成）。
-- ============================================================

-- ---- public: 月次に全日ベース稼働率を追加 ----
create or replace view mart_occupancy_monthly as
select
  rs.facility,
  rs.source_month as month,
  sum(rs.sold) as rooms_sold,
  count(distinct rs.stay_date) filter (where rs.sold > 0) as operating_days,
  coalesce(max(od.rooms), max(f.total_rooms)) as total_rooms,
  -- 稼働日ベース（従来）: 分母 = 客室数 × 稼働日数（売上実績のある日）
  case when coalesce(max(od.rooms), max(f.total_rooms)) > 0
        and count(distinct rs.stay_date) filter (where rs.sold > 0) > 0
    then round(sum(rs.sold)::numeric
      / (coalesce(max(od.rooms), max(f.total_rooms)) * count(distinct rs.stay_date) filter (where rs.sold > 0)), 4)
  end as occ,
  -- 全日ベース（新規・主）: 分母 = 客室数 × その月の暦日数
  case when coalesce(max(od.rooms), max(f.total_rooms)) > 0
    then round(sum(rs.sold)::numeric
      / (coalesce(max(od.rooms), max(f.total_rooms))
         * extract(day from (date_trunc('month', (rs.source_month || '-01')::date) + interval '1 month' - interval '1 day'))), 4)
  end as occ_calendar_days
from raw_room_sales rs
left join dim_facility f on rs.facility = f.facility
left join dim_operating_days od on od.facility = rs.facility and od.month = rs.source_month
where rs.scope = 'total'
group by rs.facility, rs.source_month;
-- 再定義で security_invoker が初期化されるため必ず on に戻す（下表RLSを閲覧者権限で継承。棚卸2026-07-21）
alter view mart_occupancy_monthly set (security_invoker = on);

-- ---- mart_ai: select * ビューを再作成して新列を反映 ----
create or replace view mart_ai.mart_occupancy_monthly as select * from public.mart_occupancy_monthly;

-- ---- 動作確認 ----
-- select facility, month, rooms_sold, operating_days, total_rooms, occ, occ_calendar_days
--   from mart_occupancy_monthly order by month desc limit 12;
-- occ >= occ_calendar_days になるはず（稼働日数 <= 暦日数 のため分母が大きい全日ベースの方が低い）

-- ---- ロールバック（occ_calendar_days を外して元に戻す） ----
-- create or replace view mart_occupancy_monthly as
-- select rs.facility, rs.source_month as month, sum(rs.sold) as rooms_sold,
--   count(distinct rs.stay_date) filter (where rs.sold > 0) as operating_days,
--   coalesce(max(od.rooms), max(f.total_rooms)) as total_rooms,
--   case when coalesce(max(od.rooms), max(f.total_rooms)) > 0
--         and count(distinct rs.stay_date) filter (where rs.sold > 0) > 0
--     then round(sum(rs.sold)::numeric / (coalesce(max(od.rooms), max(f.total_rooms))
--       * count(distinct rs.stay_date) filter (where rs.sold > 0)), 4) end as occ
-- from raw_room_sales rs
-- left join dim_facility f on rs.facility = f.facility
-- left join dim_operating_days od on od.facility = rs.facility and od.month = rs.source_month
-- where rs.scope = 'total' group by rs.facility, rs.source_month;
-- create or replace view mart_ai.mart_occupancy_monthly as select * from public.mart_occupancy_monthly;
