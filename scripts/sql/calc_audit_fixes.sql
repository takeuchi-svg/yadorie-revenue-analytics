-- ============================================================
--  計算監査フィックス（2026-07）  Supabase SQL Editor にこの全文を貼り付けて Run（冪等）
--
--  含まれる修正:
--   [1] dim_operating_days 作成＋ 月別客室数上書き列 rooms（稼働日数は手入力せず実績から自動算出）
--       → 改装等で月により部屋数が変わる施設（例: FRY 6月まで10室→7月から13室）に対応
--   [2] 稼働率ビュー: 分母を「月別客室数（上書き優先）×稼働日数（=販売実績のある日数）」に変更
--       稼働日数 = raw_room_sales(scope='total') で sold>0 の日数（販売0の日は非稼働）
--   [3] mart_monthly_kpi 再定義: 客数→人泊数 / 客単価→人泊単価 / 同伴係数→人泊÷室泊
--       （dim_budget 依存の occ/revpar/revenue_budget 列は廃止。dim_budgetは未使用の遺物）
--   [4] 売上分析系ビュー: 人数→人泊・室数→室泊 に統一（Lincoln系のADRも室泊分母に）
--   [5] 取消率: 取消 ÷ 予約（全予約。取消済み予約も予約としてカウント）に変更
--   [6] リードタイム: ABS() → GREATEST(,0)（チェックイン後受信の混入防止）
--   [7] 未使用で誤った定義を含む mart_daily を削除
--   [8] FY2025予算の category 修復（FY2026のカテゴリをitem_code単位でコピー）
-- ============================================================

-- ---- [1] 稼働日数・月別客室数マスタ ----
CREATE TABLE IF NOT EXISTS dim_operating_days (
  facility TEXT NOT NULL,
  month TEXT NOT NULL,          -- 'YYYY-MM'
  days INT,                     -- 予備列（現在は未使用。稼働日数は実績から自動算出）
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (facility, month)
);
ALTER TABLE dim_operating_days ADD COLUMN IF NOT EXISTS rooms INT;  -- 月別客室数の上書き（NULL=施設マスタの総客室数を使用）
ALTER TABLE dim_operating_days ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "operating_days_all_authenticated" ON dim_operating_days;
CREATE POLICY "operating_days_all_authenticated" ON dim_operating_days
  FOR ALL TO authenticated
  USING (public.can_access_facility(facility)) WITH CHECK (public.can_access_facility(facility));

-- ---- [2] 稼働率（正データ: 販売数集計表）: 月別客室数・手入力稼働日数を優先 ----
CREATE OR REPLACE VIEW mart_occupancy_daily AS
SELECT
  rs.facility,
  rs.stay_date AS date,
  TO_CHAR(rs.stay_date, 'Dy') AS dow,
  rs.sold AS rooms_sold,
  COALESCE(od.rooms, f.total_rooms) AS total_rooms,
  CASE WHEN COALESCE(od.rooms, f.total_rooms) > 0
    THEN ROUND(rs.sold::NUMERIC / COALESCE(od.rooms, f.total_rooms), 4) END AS occ
FROM raw_room_sales rs
LEFT JOIN dim_facility f ON rs.facility = f.facility
LEFT JOIN dim_operating_days od ON od.facility = rs.facility AND od.month = TO_CHAR(rs.stay_date, 'YYYY-MM')
WHERE rs.scope = 'total';
ALTER VIEW mart_occupancy_daily SET (security_invoker = on);

CREATE OR REPLACE VIEW mart_occupancy_monthly AS
SELECT
  rs.facility,
  rs.source_month AS month,
  SUM(rs.sold) AS rooms_sold,
  COUNT(DISTINCT rs.stay_date) FILTER (WHERE rs.sold > 0) AS operating_days,  -- 稼働日数=販売実績のある日数（自動算出）
  COALESCE(MAX(od.rooms), MAX(f.total_rooms)) AS total_rooms,                 -- 月別上書き優先
  CASE WHEN COALESCE(MAX(od.rooms), MAX(f.total_rooms)) > 0
        AND COUNT(DISTINCT rs.stay_date) FILTER (WHERE rs.sold > 0) > 0
    THEN ROUND(SUM(rs.sold)::NUMERIC
      / (COALESCE(MAX(od.rooms), MAX(f.total_rooms)) * COUNT(DISTINCT rs.stay_date) FILTER (WHERE rs.sold > 0)), 4)
  END AS occ
FROM raw_room_sales rs
LEFT JOIN dim_facility f ON rs.facility = f.facility
LEFT JOIN dim_operating_days od ON od.facility = rs.facility AND od.month = rs.source_month
WHERE rs.scope = 'total'
GROUP BY rs.facility, rs.source_month;
ALTER VIEW mart_occupancy_monthly SET (security_invoker = on);

-- ---- [3] 月次KPI: 人泊ベースに統一（チェックイン月帰属は維持=freee計上基準） ----
DROP VIEW IF EXISTS mart_monthly_kpi;
CREATE VIEW mart_monthly_kpi AS
SELECT
  facility,
  TO_CHAR(checkin, 'YYYY-MM') AS month,
  SUM(revenue_settled) AS revenue,
  SUM(nights) AS rooms_sold,                                        -- 室泊（1予約行=1部屋を確認済み）
  SUM(guests_total * GREATEST(nights, 1)) AS guests,                -- 人泊
  CASE WHEN SUM(nights) > 0
    THEN ROUND(SUM(revenue_settled)::NUMERIC / SUM(nights)) END AS adr,
  CASE WHEN SUM(guests_total * GREATEST(nights, 1)) > 0
    THEN ROUND(SUM(revenue_settled)::NUMERIC / SUM(guests_total * GREATEST(nights, 1))) END AS guest_unit,  -- 人泊単価
  CASE WHEN SUM(nights) > 0
    THEN ROUND(SUM(guests_total * GREATEST(nights, 1))::NUMERIC / SUM(nights), 2) END AS companion          -- 人泊÷室泊
FROM raw_reservation
WHERE status = 'C/O' AND nights > 0
GROUP BY facility, TO_CHAR(checkin, 'YYYY-MM');
ALTER VIEW mart_monthly_kpi SET (security_invoker = on);
GRANT SELECT ON mart_monthly_kpi TO authenticated;

-- ---- [4] 売上分析系: 人泊・室泊に統一 ----
CREATE OR REPLACE VIEW mart_channel_monthly AS
SELECT
  facility, TO_CHAR(checkin, 'YYYY-MM') AS month, channel,
  SUM(revenue_settled) AS revenue,
  SUM(nights) AS rooms,
  SUM(guests_total * GREATEST(nights, 1)) AS guests,
  CASE WHEN SUM(nights) > 0
    THEN ROUND(SUM(revenue_settled)::NUMERIC / SUM(nights)) END AS adr,
  CASE WHEN SUM(guests_total * GREATEST(nights, 1)) > 0
    THEN ROUND(SUM(revenue_settled)::NUMERIC / SUM(guests_total * GREATEST(nights, 1))) END AS guest_unit
FROM raw_reservation
WHERE status = 'C/O' AND nights > 0
GROUP BY facility, TO_CHAR(checkin, 'YYYY-MM'), channel;
ALTER VIEW mart_channel_monthly SET (security_invoker = on);

CREATE OR REPLACE VIEW mart_room_monthly AS
SELECT
  facility, TO_CHAR(checkin, 'YYYY-MM') AS month, room_parsed AS room,
  SUM(revenue_settled) AS revenue,
  SUM(nights) AS rooms_sold,
  SUM(guests_total * GREATEST(nights, 1)) AS guests,
  CASE WHEN SUM(nights) > 0 THEN ROUND(SUM(revenue_settled)::NUMERIC / SUM(nights)) END AS adr,
  CASE WHEN SUM(nights) > 0
    THEN ROUND(SUM(guests_total * GREATEST(nights, 1))::NUMERIC / SUM(nights), 2) END AS companion
FROM raw_reservation
WHERE status = 'C/O' AND nights > 0 AND room_parsed IS NOT NULL
GROUP BY facility, TO_CHAR(checkin, 'YYYY-MM'), room_parsed;
ALTER VIEW mart_room_monthly SET (security_invoker = on);

CREATE OR REPLACE VIEW mart_room_type_monthly AS
SELECT facility, TO_CHAR(checkin,'YYYY-MM') AS month, room_type,
  SUM(revenue_settled) AS revenue, SUM(nights) AS rooms_sold,
  SUM(guests_total * GREATEST(nights, 1)) AS guests,
  CASE WHEN SUM(nights) > 0 THEN ROUND(SUM(revenue_settled)::NUMERIC / SUM(nights)) END AS adr
FROM raw_reservation
WHERE status = 'C/O' AND nights > 0 AND room_type IS NOT NULL
GROUP BY facility, TO_CHAR(checkin,'YYYY-MM'), room_type;
ALTER VIEW mart_room_type_monthly SET (security_invoker = on);

CREATE OR REPLACE VIEW mart_residence_monthly AS
SELECT
  facility, TO_CHAR(checkin, 'YYYY-MM') AS month, prefecture,
  CASE
    WHEN prefecture IN ('島根県','広島県','山口県','岡山県','鳥取県') THEN '中国'
    WHEN prefecture IN ('大阪府','兵庫県','京都府','奈良県','滋賀県','和歌山県') THEN '関西'
    WHEN prefecture IN ('東京都','神奈川県','千葉県','埼玉県','茨城県','栃木県','群馬県') THEN '関東'
    WHEN prefecture IN ('愛媛県','香川県','高知県','徳島県') THEN '四国'
    WHEN prefecture IN ('福岡県','佐賀県','長崎県','大分県','熊本県','宮崎県','鹿児島県','沖縄県') THEN '九州'
    WHEN prefecture IN ('愛知県','静岡県','長野県','岐阜県','三重県','新潟県','富山県','石川県','福井県','山梨県') THEN '中部'
    WHEN prefecture IN ('北海道','青森県','岩手県','秋田県','宮城県','山形県','福島県') THEN '北海道東北'
    ELSE '不明/海外'
  END AS region,
  COUNT(*) AS bookings,
  SUM(guests_total * GREATEST(nights, 1)) AS guests,
  SUM(revenue_settled) AS revenue,
  CASE WHEN SUM(guests_total * GREATEST(nights, 1)) > 0
    THEN ROUND(SUM(revenue_settled)::NUMERIC / SUM(guests_total * GREATEST(nights, 1))) END AS guest_unit
FROM raw_reservation
WHERE status = 'C/O' AND nights > 0 AND prefecture IS NOT NULL
GROUP BY facility, TO_CHAR(checkin, 'YYYY-MM'), prefecture;
ALTER VIEW mart_residence_monthly SET (security_invoker = on);

-- 喫食月次: rooms=室泊, guests=人泊
CREATE OR REPLACE VIEW mart_meal_monthly AS
WITH res_meal AS (
  SELECT bp.facility, bp.pms_id, TO_CHAR(r.checkin,'YYYY-MM') AS month,
    MIN(CASE bp.meal_type
      WHEN '2食付' THEN 1 WHEN '朝食付' THEN 2 WHEN '夕食のみ' THEN 3 WHEN '素泊り' THEN 4 ELSE 5 END) AS rk,
    MAX(r.revenue_settled) AS revenue, MAX(r.nights) AS nights,
    MAX(r.guests_total * GREATEST(r.nights, 1)) AS guest_nights
  FROM raw_basic_product bp
  JOIN raw_reservation r ON bp.facility = r.facility AND bp.pms_id = r.pms_id
  WHERE r.status = 'C/O' AND r.nights > 0
  GROUP BY bp.facility, bp.pms_id, TO_CHAR(r.checkin,'YYYY-MM')
)
SELECT facility, month,
  CASE rk WHEN 1 THEN '2食付' WHEN 2 THEN '朝食付' WHEN 3 THEN '夕食のみ' WHEN 4 THEN '素泊り' ELSE 'その他' END AS meal_type,
  COUNT(*) AS reservations, SUM(revenue) AS revenue, SUM(nights) AS rooms, SUM(guest_nights) AS guests
FROM res_meal
GROUP BY facility, month, rk;
ALTER VIEW mart_meal_monthly SET (security_invoker = on);

-- Lincoln系（予約イベント）: 室泊=rooms×泊数, 人泊=人数×泊数, ADR=売上÷室泊
CREATE OR REPLACE VIEW mart_booking_lt AS
SELECT
  facility, TO_CHAR(checkin, 'YYYY-MM') AS month,
  CASE
    WHEN GREATEST(checkin - received_at, 0) <= 6 THEN '0-6日前'
    WHEN GREATEST(checkin - received_at, 0) <= 13 THEN '7-13日前'
    WHEN GREATEST(checkin - received_at, 0) <= 20 THEN '14-20日前'
    WHEN GREATEST(checkin - received_at, 0) <= 27 THEN '21-27日前'
    WHEN GREATEST(checkin - received_at, 0) <= 55 THEN '28-55日前'
    WHEN GREATEST(checkin - received_at, 0) <= 83 THEN '56-83日前'
    WHEN GREATEST(checkin - received_at, 0) <= 111 THEN '84-111日前'
    ELSE '112日以上前'
  END AS bucket,
  SUM(amount_gross) AS revenue,
  SUM(rooms * GREATEST(nights, 1)) AS rooms_total,
  SUM(guests_total * GREATEST(nights, 1)) AS guests,
  CASE WHEN SUM(rooms * GREATEST(nights, 1)) > 0
    THEN ROUND(SUM(amount_gross)::NUMERIC / SUM(rooms * GREATEST(nights, 1))) END AS adr,
  COUNT(*) AS count
FROM raw_booking_event
WHERE event_type = '予約'
GROUP BY facility, TO_CHAR(checkin, 'YYYY-MM'), bucket;
ALTER VIEW mart_booking_lt SET (security_invoker = on);

CREATE OR REPLACE VIEW mart_gs_monthly AS
SELECT
  facility, TO_CHAR(checkin, 'YYYY-MM') AS month,
  CASE
    WHEN ROUND(guests_total::NUMERIC / GREATEST(rooms, 1)) <= 1 THEN '1名'
    WHEN ROUND(guests_total::NUMERIC / GREATEST(rooms, 1)) = 2 THEN '2名'
    WHEN ROUND(guests_total::NUMERIC / GREATEST(rooms, 1)) = 3 THEN '3名'
    WHEN ROUND(guests_total::NUMERIC / GREATEST(rooms, 1)) = 4 THEN '4名'
    ELSE '5名以上'
  END AS group_size,
  COUNT(*) AS bookings,
  SUM(amount_gross) AS revenue,
  SUM(rooms * GREATEST(nights, 1)) AS rooms_total,
  CASE WHEN SUM(rooms * GREATEST(nights, 1)) > 0
    THEN ROUND(SUM(amount_gross)::NUMERIC / SUM(rooms * GREATEST(nights, 1))) END AS adr
FROM raw_booking_event
WHERE event_type = '予約'
GROUP BY facility, TO_CHAR(checkin, 'YYYY-MM'), group_size;
ALTER VIEW mart_gs_monthly SET (security_invoker = on);

CREATE OR REPLACE VIEW mart_plan_monthly AS
SELECT facility, TO_CHAR(checkin,'YYYY-MM') AS month, plan,
  COUNT(*) AS bookings,
  SUM(amount_gross) AS revenue,
  SUM(rooms * GREATEST(nights, 1)) AS rooms_total,
  SUM(guests_total * GREATEST(nights, 1)) AS guests,
  CASE WHEN SUM(rooms * GREATEST(nights, 1)) > 0
    THEN ROUND(SUM(amount_gross)::NUMERIC / SUM(rooms * GREATEST(nights, 1))) END AS adr
FROM raw_booking_event
WHERE event_type = '予約' AND plan IS NOT NULL AND plan <> ''
GROUP BY facility, TO_CHAR(checkin,'YYYY-MM'), plan;
ALTER VIEW mart_plan_monthly SET (security_invoker = on);

CREATE OR REPLACE VIEW mart_adr_band_monthly AS
SELECT facility, TO_CHAR(checkin,'YYYY-MM') AS month,
  CASE
    WHEN amount_gross::NUMERIC / GREATEST(rooms * GREATEST(nights, 1), 1) < 30000 THEN '〜¥30K'
    WHEN amount_gross::NUMERIC / GREATEST(rooms * GREATEST(nights, 1), 1) < 50000 THEN '¥30-50K'
    WHEN amount_gross::NUMERIC / GREATEST(rooms * GREATEST(nights, 1), 1) < 70000 THEN '¥50-70K'
    WHEN amount_gross::NUMERIC / GREATEST(rooms * GREATEST(nights, 1), 1) < 100000 THEN '¥70-100K'
    ELSE '¥100K〜'
  END AS band,
  COUNT(*) AS bookings,
  SUM(amount_gross) AS revenue,
  SUM(rooms * GREATEST(nights, 1)) AS rooms_total,
  CASE WHEN SUM(rooms * GREATEST(nights, 1)) > 0
    THEN ROUND(SUM(amount_gross)::NUMERIC / SUM(rooms * GREATEST(nights, 1))) END AS adr
FROM raw_booking_event
WHERE event_type = '予約' AND rooms > 0
GROUP BY facility, TO_CHAR(checkin,'YYYY-MM'), band;
ALTER VIEW mart_adr_band_monthly SET (security_invoker = on);

-- ---- [5] 取消率 = 取消 ÷ 予約（全予約。予約0件はNULL） ----
CREATE OR REPLACE VIEW mart_cxl_summary AS
SELECT
  facility, TO_CHAR(checkin, 'YYYY-MM') AS month, channel,
  COUNT(*) FILTER (WHERE event_type = '予約') AS bookings,
  COUNT(*) FILTER (WHERE event_type = '取消') AS cancels,
  SUM(amount_gross) FILTER (WHERE event_type = '取消') AS cancel_revenue,
  CASE WHEN COUNT(*) FILTER (WHERE event_type = '予約') > 0
    THEN ROUND(
      COUNT(*) FILTER (WHERE event_type = '取消')::NUMERIC
      / COUNT(*) FILTER (WHERE event_type = '予約'), 4
    ) END AS cxl_rate
FROM raw_booking_event
WHERE event_type IN ('予約', '取消')
GROUP BY facility, TO_CHAR(checkin, 'YYYY-MM'), channel;
ALTER VIEW mart_cxl_summary SET (security_invoker = on);

-- ---- [6] 取消LT: GREATEST(,0) ----
CREATE OR REPLACE VIEW mart_cxl_lt AS
SELECT
  facility, TO_CHAR(checkin, 'YYYY-MM') AS month,
  CASE
    WHEN GREATEST(checkin - received_at, 0) <= 0 THEN '当日'
    WHEN GREATEST(checkin - received_at, 0) <= 3 THEN '1-3日前'
    WHEN GREATEST(checkin - received_at, 0) <= 6 THEN '4-6日前'
    WHEN GREATEST(checkin - received_at, 0) <= 13 THEN '7-13日前'
    WHEN GREATEST(checkin - received_at, 0) <= 20 THEN '14-20日前'
    WHEN GREATEST(checkin - received_at, 0) <= 27 THEN '21-27日前'
    WHEN GREATEST(checkin - received_at, 0) <= 55 THEN '28-55日前'
    WHEN GREATEST(checkin - received_at, 0) <= 83 THEN '56-83日前'
    WHEN GREATEST(checkin - received_at, 0) <= 111 THEN '84-111日前'
    ELSE '112日以上前'
  END AS bucket,
  COUNT(*) AS count
FROM raw_booking_event
WHERE event_type = '取消'
GROUP BY facility, TO_CHAR(checkin, 'YYYY-MM'), bucket;
ALTER VIEW mart_cxl_lt SET (security_invoker = on);

-- ---- [7] 未使用・誤定義ビューの削除（泊数をチェックイン日に全計上する稼働率を含んでいた） ----
DROP VIEW IF EXISTS mart_daily;

-- ---- [8] FY2025予算の category 修復（FY2026 のカテゴリを item_code 単位でコピー） ----
UPDATE budget_monthly b
SET category = c.category
FROM (
  SELECT DISTINCT item_code, category FROM budget_monthly WHERE fiscal_year = '2026'
) c
WHERE b.fiscal_year = '2025'
  AND b.item_code = c.item_code
  AND b.category IS DISTINCT FROM c.category;

-- 確認用:
--   select fiscal_year, category, count(distinct item_code) from budget_monthly group by 1,2 order by 1,2;
--   select * from dim_operating_days;
