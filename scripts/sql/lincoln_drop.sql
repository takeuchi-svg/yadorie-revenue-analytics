-- ============================================================
--  リンカーン完全削除: raw_booking_event をDBから削除
--    Supabase SQL Editor で Run（冪等・自己完結。lincoln_retire.sql を未適用でも安全）
--
--  手順:
--   1) 依存する mart 6種を raw_reservation ベースに再定義（raw_booking_event 依存を断つ）
--   2) raw_booking_event テーブルを削除（データごと）
--
--  ※ この操作でリンカーンの数値はDBから完全に消えます（復元不可）。
--    以降のCXL・売上分析・AIはすべてステイシー(raw_reservation)基準。
-- ============================================================

-- ---- 1) mart を raw_reservation ベースへ（lincoln_retire.sql と同一定義・冪等） ----
DROP VIEW IF EXISTS mart_cxl_summary;
CREATE VIEW mart_cxl_summary AS
SELECT facility, TO_CHAR(checkin, 'YYYY-MM') AS month, COALESCE(channel, '不明') AS channel,
  COUNT(*) AS bookings,
  COUNT(*) FILTER (WHERE status = 'キャンセル') AS cancels,
  SUM(revenue_settled) FILTER (WHERE status = 'キャンセル') AS cancel_revenue,
  CASE WHEN COUNT(*) > 0 THEN ROUND(COUNT(*) FILTER (WHERE status = 'キャンセル')::NUMERIC / COUNT(*), 4) END AS cxl_rate
FROM raw_reservation WHERE status NOT IN ('販売不可', '空部屋')
GROUP BY facility, TO_CHAR(checkin, 'YYYY-MM'), COALESCE(channel, '不明');
ALTER VIEW mart_cxl_summary SET (security_invoker = on);

DROP VIEW IF EXISTS mart_cxl_lt;
CREATE VIEW mart_cxl_lt AS
SELECT facility, TO_CHAR(checkin, 'YYYY-MM') AS month,
  CASE
    WHEN GREATEST(checkin - booking_date, 0) <= 0 THEN '当日'
    WHEN GREATEST(checkin - booking_date, 0) <= 3 THEN '1-3日前'
    WHEN GREATEST(checkin - booking_date, 0) <= 6 THEN '4-6日前'
    WHEN GREATEST(checkin - booking_date, 0) <= 13 THEN '7-13日前'
    WHEN GREATEST(checkin - booking_date, 0) <= 20 THEN '14-20日前'
    WHEN GREATEST(checkin - booking_date, 0) <= 27 THEN '21-27日前'
    WHEN GREATEST(checkin - booking_date, 0) <= 55 THEN '28-55日前'
    WHEN GREATEST(checkin - booking_date, 0) <= 83 THEN '56-83日前'
    WHEN GREATEST(checkin - booking_date, 0) <= 111 THEN '84-111日前'
    ELSE '112日以上前'
  END AS bucket, COUNT(*) AS count
FROM raw_reservation WHERE status = 'キャンセル' AND booking_date IS NOT NULL
GROUP BY facility, TO_CHAR(checkin, 'YYYY-MM'), bucket;
ALTER VIEW mart_cxl_lt SET (security_invoker = on);

DROP VIEW IF EXISTS mart_plan_monthly;
CREATE VIEW mart_plan_monthly AS
SELECT facility, TO_CHAR(checkin, 'YYYY-MM') AS month, plan,
  COUNT(*) AS bookings, SUM(revenue_settled) AS revenue, SUM(nights) AS rooms_total,
  SUM(guests_total * GREATEST(nights, 1)) AS guests,
  CASE WHEN SUM(nights) > 0 THEN ROUND(SUM(revenue_settled)::NUMERIC / SUM(nights)) END AS adr
FROM raw_reservation WHERE status = 'C/O' AND nights > 0 AND plan IS NOT NULL AND plan <> ''
GROUP BY facility, TO_CHAR(checkin, 'YYYY-MM'), plan;
ALTER VIEW mart_plan_monthly SET (security_invoker = on);

DROP VIEW IF EXISTS mart_gs_monthly;
CREATE VIEW mart_gs_monthly AS
SELECT facility, TO_CHAR(checkin, 'YYYY-MM') AS month,
  CASE
    WHEN ROUND(guests_total::NUMERIC / GREATEST(COALESCE(room_count, 1), 1)) <= 1 THEN '1名'
    WHEN ROUND(guests_total::NUMERIC / GREATEST(COALESCE(room_count, 1), 1)) = 2 THEN '2名'
    WHEN ROUND(guests_total::NUMERIC / GREATEST(COALESCE(room_count, 1), 1)) = 3 THEN '3名'
    WHEN ROUND(guests_total::NUMERIC / GREATEST(COALESCE(room_count, 1), 1)) = 4 THEN '4名'
    ELSE '5名以上'
  END AS group_size,
  COUNT(*) AS bookings, SUM(revenue_settled) AS revenue, SUM(nights) AS rooms_total,
  CASE WHEN SUM(nights) > 0 THEN ROUND(SUM(revenue_settled)::NUMERIC / SUM(nights)) END AS adr
FROM raw_reservation WHERE status = 'C/O' AND nights > 0
GROUP BY facility, TO_CHAR(checkin, 'YYYY-MM'), group_size;
ALTER VIEW mart_gs_monthly SET (security_invoker = on);

DROP VIEW IF EXISTS mart_adr_band_monthly;
CREATE VIEW mart_adr_band_monthly AS
SELECT facility, TO_CHAR(checkin, 'YYYY-MM') AS month,
  CASE
    WHEN revenue_settled::NUMERIC / GREATEST(nights, 1) < 30000 THEN '〜¥30K'
    WHEN revenue_settled::NUMERIC / GREATEST(nights, 1) < 50000 THEN '¥30-50K'
    WHEN revenue_settled::NUMERIC / GREATEST(nights, 1) < 70000 THEN '¥50-70K'
    WHEN revenue_settled::NUMERIC / GREATEST(nights, 1) < 100000 THEN '¥70-100K'
    ELSE '¥100K〜'
  END AS band,
  COUNT(*) AS bookings, SUM(revenue_settled) AS revenue, SUM(nights) AS rooms_total,
  CASE WHEN SUM(nights) > 0 THEN ROUND(SUM(revenue_settled)::NUMERIC / SUM(nights)) END AS adr
FROM raw_reservation WHERE status = 'C/O' AND nights > 0
GROUP BY facility, TO_CHAR(checkin, 'YYYY-MM'), band;
ALTER VIEW mart_adr_band_monthly SET (security_invoker = on);

DROP VIEW IF EXISTS mart_booking_lt;
CREATE VIEW mart_booking_lt AS
SELECT facility, TO_CHAR(checkin, 'YYYY-MM') AS month,
  CASE
    WHEN GREATEST(checkin - booking_date, 0) <= 6 THEN '0-6日前'
    WHEN GREATEST(checkin - booking_date, 0) <= 13 THEN '7-13日前'
    WHEN GREATEST(checkin - booking_date, 0) <= 20 THEN '14-20日前'
    WHEN GREATEST(checkin - booking_date, 0) <= 27 THEN '21-27日前'
    WHEN GREATEST(checkin - booking_date, 0) <= 55 THEN '28-55日前'
    WHEN GREATEST(checkin - booking_date, 0) <= 83 THEN '56-83日前'
    WHEN GREATEST(checkin - booking_date, 0) <= 111 THEN '84-111日前'
    ELSE '112日以上前'
  END AS bucket,
  SUM(revenue_settled) AS revenue, SUM(nights) AS rooms_total,
  SUM(guests_total * GREATEST(nights, 1)) AS guests,
  CASE WHEN SUM(nights) > 0 THEN ROUND(SUM(revenue_settled)::NUMERIC / SUM(nights)) END AS adr,
  COUNT(*) AS count
FROM raw_reservation WHERE status = 'C/O' AND nights > 0 AND booking_date IS NOT NULL
GROUP BY facility, TO_CHAR(checkin, 'YYYY-MM'), bucket;
ALTER VIEW mart_booking_lt SET (security_invoker = on);

GRANT SELECT ON mart_cxl_summary, mart_cxl_lt, mart_plan_monthly, mart_gs_monthly, mart_adr_band_monthly, mart_booking_lt TO authenticated;

-- ---- 2) raw_booking_event を削除（データごと・CASCADEで残依存も除去） ----
DROP TABLE IF EXISTS raw_booking_event CASCADE;

-- 確認用:
--   select to_regclass('public.raw_booking_event');   -- → NULL なら削除完了
