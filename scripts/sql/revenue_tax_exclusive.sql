-- ============================================================
--  売上分析を税抜き基準へ（棚卸2026-07-23）／Supabase SQL Editor で Run（冪等）
--
--  背景: 売上分析KPIは Staysee 精算額(=請求金額・税込)を使っていた。会計PL(税抜)と
--    約1.1倍ズレる。予約情報CSVには「税抜き金額」(=請求−消費税−入湯税−宿泊税)があり、
--    これがPLと同基準。取込に列を足し(revenue_net ほか)、売上系マートを税抜へ切替える。
--
--  ★適用順:
--    1) このファイル（列追加＋calc_audit系の売上6マートを税抜で再作成）
--    2) lincoln_retire.sql / booking_analysis_setup.sql / onhand_setup.sql を再Run（税抜へ更新済）
--    3) 予約情報CSVを全宿ぶん再取込 → revenue_net が入り税抜が反映（未取込の行は COALESCE で
--       revenue_settled(税込)にフォールバック＝壊れない）
--
--  ※ calc_audit_fixes.sql は raw_booking_event(撤去済)依存の旧ビューを含み単体再実行不可のため、
--    その売上6マートだけをここに税抜版で再定義する（他は上記2で再Run）。
-- ============================================================

-- ---- [1] 税抜き金額・税額の列を raw_reservation に追加 ----
alter table raw_reservation
  add column if not exists revenue_net      integer,   -- 税抜き金額（=請求−消費税−入湯税−宿泊税）
  add column if not exists consumption_tax  integer,   -- 消費税
  add column if not exists bathing_tax      integer,   -- 入湯税
  add column if not exists lodging_tax      integer;   -- 宿泊税

-- 売上=COALESCE(revenue_net, revenue_settled)：再取込前は税込にフォールバック。
-- ---- [2] 月次KPI（売上・室泊・人泊・ADR・客単価） ----
DROP VIEW IF EXISTS mart_monthly_kpi;
CREATE VIEW mart_monthly_kpi AS
SELECT
  facility,
  TO_CHAR(checkin, 'YYYY-MM') AS month,
  SUM(COALESCE(revenue_net, revenue_settled)) AS revenue,
  SUM(nights) AS rooms_sold,
  SUM(guests_total * GREATEST(nights, 1)) AS guests,
  CASE WHEN SUM(nights) > 0
    THEN ROUND(SUM(COALESCE(revenue_net, revenue_settled))::NUMERIC / SUM(nights)) END AS adr,
  CASE WHEN SUM(guests_total * GREATEST(nights, 1)) > 0
    THEN ROUND(SUM(COALESCE(revenue_net, revenue_settled))::NUMERIC / SUM(guests_total * GREATEST(nights, 1))) END AS guest_unit,
  CASE WHEN SUM(nights) > 0
    THEN ROUND(SUM(guests_total * GREATEST(nights, 1))::NUMERIC / SUM(nights), 2) END AS companion
FROM raw_reservation
WHERE status = 'C/O' AND nights > 0
GROUP BY facility, TO_CHAR(checkin, 'YYYY-MM');
ALTER VIEW mart_monthly_kpi SET (security_invoker = on);
GRANT SELECT ON mart_monthly_kpi TO authenticated;

-- ---- [3] チャネル別月次 ----
CREATE OR REPLACE VIEW mart_channel_monthly AS
SELECT
  facility, TO_CHAR(checkin, 'YYYY-MM') AS month, channel,
  SUM(COALESCE(revenue_net, revenue_settled)) AS revenue,
  SUM(nights) AS rooms,
  SUM(guests_total * GREATEST(nights, 1)) AS guests,
  CASE WHEN SUM(nights) > 0
    THEN ROUND(SUM(COALESCE(revenue_net, revenue_settled))::NUMERIC / SUM(nights)) END AS adr,
  CASE WHEN SUM(guests_total * GREATEST(nights, 1)) > 0
    THEN ROUND(SUM(COALESCE(revenue_net, revenue_settled))::NUMERIC / SUM(guests_total * GREATEST(nights, 1))) END AS guest_unit
FROM raw_reservation
WHERE status = 'C/O' AND nights > 0
GROUP BY facility, TO_CHAR(checkin, 'YYYY-MM'), channel;
ALTER VIEW mart_channel_monthly SET (security_invoker = on);

-- ---- [4] 部屋別月次 ----
CREATE OR REPLACE VIEW mart_room_monthly AS
SELECT
  facility, TO_CHAR(checkin, 'YYYY-MM') AS month, room_parsed AS room,
  SUM(COALESCE(revenue_net, revenue_settled)) AS revenue,
  SUM(nights) AS rooms_sold,
  SUM(guests_total * GREATEST(nights, 1)) AS guests,
  CASE WHEN SUM(nights) > 0 THEN ROUND(SUM(COALESCE(revenue_net, revenue_settled))::NUMERIC / SUM(nights)) END AS adr,
  CASE WHEN SUM(nights) > 0
    THEN ROUND(SUM(guests_total * GREATEST(nights, 1))::NUMERIC / SUM(nights), 2) END AS companion
FROM raw_reservation
WHERE status = 'C/O' AND nights > 0 AND room_parsed IS NOT NULL
GROUP BY facility, TO_CHAR(checkin, 'YYYY-MM'), room_parsed;
ALTER VIEW mart_room_monthly SET (security_invoker = on);

-- ---- [5] 部屋タイプ別月次 ----
CREATE OR REPLACE VIEW mart_room_type_monthly AS
SELECT facility, TO_CHAR(checkin,'YYYY-MM') AS month, room_type,
  SUM(COALESCE(revenue_net, revenue_settled)) AS revenue, SUM(nights) AS rooms_sold,
  SUM(guests_total * GREATEST(nights, 1)) AS guests,
  CASE WHEN SUM(nights) > 0 THEN ROUND(SUM(COALESCE(revenue_net, revenue_settled))::NUMERIC / SUM(nights)) END AS adr
FROM raw_reservation
WHERE status = 'C/O' AND nights > 0 AND room_type IS NOT NULL
GROUP BY facility, TO_CHAR(checkin,'YYYY-MM'), room_type;
ALTER VIEW mart_room_type_monthly SET (security_invoker = on);

-- ---- [6] 客層(居住地)別月次 ----
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
  SUM(COALESCE(revenue_net, revenue_settled)) AS revenue,
  CASE WHEN SUM(guests_total * GREATEST(nights, 1)) > 0
    THEN ROUND(SUM(COALESCE(revenue_net, revenue_settled))::NUMERIC / SUM(guests_total * GREATEST(nights, 1))) END AS guest_unit
FROM raw_reservation
WHERE status = 'C/O' AND nights > 0 AND prefecture IS NOT NULL
GROUP BY facility, TO_CHAR(checkin, 'YYYY-MM'), prefecture;
ALTER VIEW mart_residence_monthly SET (security_invoker = on);

-- ---- [7] 喫食月次（基本商品と結合） ----
CREATE OR REPLACE VIEW mart_meal_monthly AS
WITH res_meal AS (
  SELECT bp.facility, bp.pms_id, TO_CHAR(r.checkin,'YYYY-MM') AS month,
    MIN(CASE bp.meal_type
      WHEN '2食付' THEN 1 WHEN '朝食付' THEN 2 WHEN '夕食のみ' THEN 3 WHEN '素泊り' THEN 4 ELSE 5 END) AS rk,
    MAX(COALESCE(r.revenue_net, r.revenue_settled)) AS revenue, MAX(r.nights) AS nights,
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

-- 確認:
--   select facility, month, revenue, adr, guest_unit from mart_monthly_kpi where facility='FRY' order by month desc limit 6;
--   -- 再取込後、mart_monthly_kpi.revenue ≒ actual_monthly.sales_total（PL税抜）に近づく。
