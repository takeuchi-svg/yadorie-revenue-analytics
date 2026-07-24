-- ============================================================
--  リンカーン廃止・第3段: AI参照martをステイシー(raw_reservation)ベースへ再定義
--    Supabase SQL Editor で Run（冪等）
--
--  背景: リンカーン(raw_booking_event)取込を停止し、ステイシー予約情報に一本化。
--    ページはクライアント側でraw_reservationから集計するよう移行済み。
--    AIが参照する下記martはリンカーン由来のままだったため、ステイシー基準に統一する。
--
--  定義（すべてチェックイン月・freee計上基準）:
--   - 取消系: 予約=販売不可/空部屋を除く全予約, 取消=status'キャンセル', 取消率=取消÷全予約, LT=checkin−予約日
--   - 売上系(プラン/GS/ADR帯/予約LT): status='C/O'(確定)のみ, 売上=精算額, 室泊=nights(1予約=1室), 人泊=人数×泊数
--  ※ raw_booking_event データはDBに残置（履歴閲覧用）。ページのトグル「リンカーン(旧)」で参照可。
-- ============================================================

-- ---- 取消サマリ（チャネル別） ----
DROP VIEW IF EXISTS mart_cxl_summary;
CREATE VIEW mart_cxl_summary AS
SELECT
  facility,
  TO_CHAR(checkin, 'YYYY-MM') AS month,
  COALESCE(channel, '不明') AS channel,
  COUNT(*) AS bookings,
  COUNT(*) FILTER (WHERE status = 'キャンセル') AS cancels,
  SUM(COALESCE(revenue_net, revenue_settled)) FILTER (WHERE status = 'キャンセル') AS cancel_revenue,
  CASE WHEN COUNT(*) > 0
    THEN ROUND(COUNT(*) FILTER (WHERE status = 'キャンセル')::NUMERIC / COUNT(*), 4) END AS cxl_rate
FROM raw_reservation
WHERE status NOT IN ('販売不可', '空部屋')
GROUP BY facility, TO_CHAR(checkin, 'YYYY-MM'), COALESCE(channel, '不明');
ALTER VIEW mart_cxl_summary SET (security_invoker = on);

-- ---- 取消リードタイム（予約日基準） ----
DROP VIEW IF EXISTS mart_cxl_lt;
CREATE VIEW mart_cxl_lt AS
SELECT
  facility,
  TO_CHAR(checkin, 'YYYY-MM') AS month,
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
  END AS bucket,
  COUNT(*) AS count
FROM raw_reservation
WHERE status = 'キャンセル' AND booking_date IS NOT NULL
GROUP BY facility, TO_CHAR(checkin, 'YYYY-MM'), bucket;
ALTER VIEW mart_cxl_lt SET (security_invoker = on);

-- ---- プラン月次（C/O確定） ----
DROP VIEW IF EXISTS mart_plan_monthly;
CREATE VIEW mart_plan_monthly AS
SELECT facility, TO_CHAR(checkin, 'YYYY-MM') AS month, plan,
  COUNT(*) AS bookings,
  SUM(COALESCE(revenue_net, revenue_settled)) AS revenue,
  SUM(nights) AS rooms_total,
  SUM(guests_total * GREATEST(nights, 1)) AS guests,
  CASE WHEN SUM(nights) > 0 THEN ROUND(SUM(COALESCE(revenue_net, revenue_settled))::NUMERIC / SUM(nights)) END AS adr
FROM raw_reservation
WHERE status = 'C/O' AND nights > 0 AND plan IS NOT NULL AND plan <> ''
GROUP BY facility, TO_CHAR(checkin, 'YYYY-MM'), plan;
ALTER VIEW mart_plan_monthly SET (security_invoker = on);

-- ---- グループサイズ月次（C/O確定） ----
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
  COUNT(*) AS bookings,
  SUM(COALESCE(revenue_net, revenue_settled)) AS revenue,
  SUM(nights) AS rooms_total,
  CASE WHEN SUM(nights) > 0 THEN ROUND(SUM(COALESCE(revenue_net, revenue_settled))::NUMERIC / SUM(nights)) END AS adr
FROM raw_reservation
WHERE status = 'C/O' AND nights > 0
GROUP BY facility, TO_CHAR(checkin, 'YYYY-MM'), group_size;
ALTER VIEW mart_gs_monthly SET (security_invoker = on);

-- ---- ADR帯月次（C/O確定・1室1泊あたり） ----
DROP VIEW IF EXISTS mart_adr_band_monthly;
CREATE VIEW mart_adr_band_monthly AS
SELECT facility, TO_CHAR(checkin, 'YYYY-MM') AS month,
  CASE
    WHEN COALESCE(revenue_net, revenue_settled)::NUMERIC / GREATEST(nights, 1) < 30000 THEN '〜¥30K'
    WHEN COALESCE(revenue_net, revenue_settled)::NUMERIC / GREATEST(nights, 1) < 50000 THEN '¥30-50K'
    WHEN COALESCE(revenue_net, revenue_settled)::NUMERIC / GREATEST(nights, 1) < 70000 THEN '¥50-70K'
    WHEN COALESCE(revenue_net, revenue_settled)::NUMERIC / GREATEST(nights, 1) < 100000 THEN '¥70-100K'
    ELSE '¥100K〜'
  END AS band,
  COUNT(*) AS bookings,
  SUM(COALESCE(revenue_net, revenue_settled)) AS revenue,
  SUM(nights) AS rooms_total,
  CASE WHEN SUM(nights) > 0 THEN ROUND(SUM(COALESCE(revenue_net, revenue_settled))::NUMERIC / SUM(nights)) END AS adr
FROM raw_reservation
WHERE status = 'C/O' AND nights > 0
GROUP BY facility, TO_CHAR(checkin, 'YYYY-MM'), band;
ALTER VIEW mart_adr_band_monthly SET (security_invoker = on);

-- ---- 予約リードタイム月次（C/O確定・予約日基準） ----
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
  SUM(COALESCE(revenue_net, revenue_settled)) AS revenue,
  SUM(nights) AS rooms_total,
  SUM(guests_total * GREATEST(nights, 1)) AS guests,
  CASE WHEN SUM(nights) > 0 THEN ROUND(SUM(COALESCE(revenue_net, revenue_settled))::NUMERIC / SUM(nights)) END AS adr,
  COUNT(*) AS count
FROM raw_reservation
WHERE status = 'C/O' AND nights > 0 AND booking_date IS NOT NULL
GROUP BY facility, TO_CHAR(checkin, 'YYYY-MM'), bucket;
ALTER VIEW mart_booking_lt SET (security_invoker = on);

GRANT SELECT ON mart_cxl_summary, mart_cxl_lt, mart_plan_monthly, mart_gs_monthly, mart_adr_band_monthly, mart_booking_lt TO authenticated;

-- 確認用:
--   select * from mart_cxl_summary where facility='FRY' order by month desc limit 20;
--   select * from mart_plan_monthly where facility='FRY' order by revenue desc limit 10;
