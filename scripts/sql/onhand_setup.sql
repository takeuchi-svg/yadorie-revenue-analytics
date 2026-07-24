-- ============================================================
--  オンハンド（予約の積み上がり）  Supabase SQL Editor で Run（冪等）
--
--  ステイシー予約情報に一本化する第一歩。将来月の「予約情報」CSVを取り込むと、
--  未チェックインの生きた予約（未確認/予約確定/重要予約）が raw_reservation に入る。
--  それを checkin 月・日で集計して「現在のオンハンド（予約の入り具合）」を出す。
--
--  ステータスの扱い（実データ確認済み）:
--   - オンハンド（予約が生きている）= 未確認 / 予約確定 / 重要予約 / C/O
--       ・未確認    … OTA自動取込で未確認（実予約。ペースには含める）
--       ・予約確定  … 確定
--       ・重要予約  … 重要/VIP
--       ・C/O       … チェックアウト済み（＝実績。当月の途中経過で混在する）
--   - 除外 = キャンセル / 販売不可 / 空部屋
--
--  ※ 現状は raw_reservation を pms_id で upsert（最新スナップショットで上書き）。
--    ブッキングペースの時系列（as-of別の履歴）は別途スナップショット保存で対応予定。
-- ============================================================

-- ---- オンハンド 月次（checkin 月で集計） ----
CREATE OR REPLACE VIEW mart_onhand_monthly AS
SELECT
  facility,
  TO_CHAR(checkin, 'YYYY-MM') AS month,
  COUNT(*)                                                              AS reservations,
  -- 室泊（1予約行=1室 × 泊数）。オンハンド＝非キャンセルの全予約
  SUM(nights)                                                          AS room_nights,
  SUM(nights) FILTER (WHERE status = 'C/O')                            AS room_nights_stayed,     -- 実績（宿泊済）
  SUM(nights) FILTER (WHERE status IN ('予約確定','重要予約'))         AS room_nights_confirmed,  -- 確定（未宿泊）
  SUM(nights) FILTER (WHERE status = '未確認')                         AS room_nights_tentative,  -- 未確認
  SUM(guests_total * GREATEST(nights, 1))                              AS guest_nights,
  SUM(COALESCE(revenue_net, revenue_settled))                                                 AS revenue,
  CASE WHEN SUM(nights) > 0
    THEN ROUND(SUM(COALESCE(revenue_net, revenue_settled))::NUMERIC / SUM(nights)) END        AS adr
FROM raw_reservation
WHERE status IN ('未確認','予約確定','重要予約','C/O')
GROUP BY facility, TO_CHAR(checkin, 'YYYY-MM');
ALTER VIEW mart_onhand_monthly SET (security_invoker = on);

-- ---- 予算 月次（budget_daily を月へロールアップ。オンハンド比較の相手） ----
CREATE OR REPLACE VIEW mart_budget_daily_monthly AS
SELECT
  facility,
  TO_CHAR(date, 'YYYY-MM') AS month,
  SUM(rooms_sold)   AS rooms_budget,
  SUM(total_revenue) AS revenue_budget,
  SUM(inventory)    AS inventory_budget
FROM budget_daily
GROUP BY facility, TO_CHAR(date, 'YYYY-MM');
ALTER VIEW mart_budget_daily_monthly SET (security_invoker = on);

-- 確認用:
--   select * from mart_onhand_monthly where facility='FRY' order by month;
--   select * from mart_budget_daily_monthly where facility='FRY' order by month;
