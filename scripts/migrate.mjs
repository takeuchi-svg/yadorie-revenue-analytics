import pg from 'pg';
const { Client } = pg;

const client = new Client({
  host: 'db.hilglsnoqkuvrkcyjrnr.supabase.co',
  port: 5432,
  database: 'postgres',
  user: 'postgres',
  password: 'ZoIb8yZ6k2LmJ9gB',
  ssl: { rejectUnauthorized: false },
});

const DDL = `
-- ========================================
-- Raw層テーブル
-- ========================================

CREATE TABLE IF NOT EXISTS raw_reservation (
  id BIGSERIAL PRIMARY KEY,
  facility TEXT NOT NULL,
  pms_id INTEGER NOT NULL,
  booking_no TEXT,
  status TEXT NOT NULL,
  channel TEXT,
  checkin DATE NOT NULL,
  checkout DATE,
  nights INTEGER DEFAULT 1,
  guests_total INTEGER DEFAULT 0,
  adults INTEGER DEFAULT 0,
  children INTEGER DEFAULT 0,
  revenue_settled INTEGER DEFAULT 0,
  room_raw TEXT,
  room_parsed TEXT,
  room_type TEXT,
  room_count INTEGER DEFAULT 1,
  prefecture TEXT,
  plan TEXT,
  booking_date DATE,
  source_month TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(facility, pms_id)
);

CREATE INDEX IF NOT EXISTS idx_res_facility_checkin ON raw_reservation(facility, checkin);
CREATE INDEX IF NOT EXISTS idx_res_facility_status ON raw_reservation(facility, status);
CREATE INDEX IF NOT EXISTS idx_res_booking_no ON raw_reservation(booking_no);

CREATE TABLE IF NOT EXISTS raw_basic_product (
  id BIGSERIAL PRIMARY KEY,
  facility TEXT NOT NULL,
  pms_id INTEGER NOT NULL,
  status TEXT,
  product_name TEXT,
  unit_price INTEGER DEFAULT 0,
  quantity INTEGER DEFAULT 0,
  dinner TEXT,
  breakfast TEXT,
  meal_type TEXT,
  source_month TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bp_facility_pmsid ON raw_basic_product(facility, pms_id);

CREATE TABLE IF NOT EXISTS raw_other_product (
  id BIGSERIAL PRIMARY KEY,
  facility TEXT NOT NULL,
  pms_id INTEGER NOT NULL,
  status TEXT,
  item_name TEXT,
  unit_price INTEGER DEFAULT 0,
  quantity INTEGER DEFAULT 0,
  total INTEGER DEFAULT 0,
  category TEXT,
  source_month TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_op_facility_pmsid ON raw_other_product(facility, pms_id);

CREATE TABLE IF NOT EXISTS raw_payment (
  id BIGSERIAL PRIMARY KEY,
  facility TEXT NOT NULL,
  pms_id INTEGER NOT NULL,
  payment_method TEXT,
  amount INTEGER DEFAULT 0,
  source_month TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS raw_booking_event (
  id BIGSERIAL PRIMARY KEY,
  facility TEXT NOT NULL,
  notify_no INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  booking_no TEXT,
  channel TEXT,
  received_at DATE,
  checkin DATE NOT NULL,
  checkout DATE,
  nights INTEGER DEFAULT 1,
  guests_total INTEGER DEFAULT 0,
  rooms INTEGER DEFAULT 1,
  amount_gross INTEGER DEFAULT 0,
  plan TEXT,
  address TEXT,
  meal_condition TEXT,
  source_csv TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(facility, notify_no)
);

CREATE INDEX IF NOT EXISTS idx_be_facility_checkin ON raw_booking_event(facility, checkin);
CREATE INDEX IF NOT EXISTS idx_be_facility_received ON raw_booking_event(facility, received_at);
CREATE INDEX IF NOT EXISTS idx_be_booking_no ON raw_booking_event(booking_no);

CREATE TABLE IF NOT EXISTS raw_rate_snapshot (
  id BIGSERIAL PRIMARY KEY,
  facility TEXT NOT NULL,
  snapshot_date DATE NOT NULL,
  stay_date DATE NOT NULL,
  dow TEXT,
  scope TEXT NOT NULL,
  room TEXT,
  rate_rank INTEGER,
  remaining INTEGER,
  sold INTEGER,
  flag_lastmin BOOLEAN DEFAULT FALSE,
  flag_sudomari BOOLEAN DEFAULT FALSE,
  flag_breakfast BOOLEAN DEFAULT FALSE,
  flag_2mei_cut BOOLEAN DEFAULT FALSE,
  flag_card BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_rs_unique
  ON raw_rate_snapshot(facility, snapshot_date, stay_date, scope, COALESCE(room, ''));

CREATE INDEX IF NOT EXISTS idx_rs_facility_staydate ON raw_rate_snapshot(facility, stay_date);

-- 販売数集計表（PMS確定販売室数：日別×客室タイプ）
CREATE TABLE IF NOT EXISTS raw_room_sales (
  id BIGSERIAL PRIMARY KEY,
  facility TEXT NOT NULL,
  stay_date DATE NOT NULL,
  scope TEXT NOT NULL,            -- 'type'（客室タイプ別） or 'total'（合計）
  room_type TEXT,                -- scope='total' のとき NULL
  sold INTEGER NOT NULL DEFAULT 0,
  source_month TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_room_sales_unique
  ON raw_room_sales(facility, stay_date, scope, COALESCE(room_type, ''));

CREATE INDEX IF NOT EXISTS idx_room_sales_facility_date ON raw_room_sales(facility, stay_date);

-- ========================================
-- 設定テーブル
-- ========================================

CREATE TABLE IF NOT EXISTS dim_facility (
  facility TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  short_name TEXT,
  total_rooms INTEGER,
  rooms_json JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS dim_budget (
  id SERIAL PRIMARY KEY,
  facility TEXT NOT NULL REFERENCES dim_facility(facility),
  month TEXT NOT NULL,
  operating_days INTEGER,
  total_inventory INTEGER,
  revenue_budget INTEGER,
  rooms_budget INTEGER,
  guests_budget INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(facility, month)
);

CREATE TABLE IF NOT EXISTS dim_ota_marketing (
  id SERIAL PRIMARY KEY,
  facility TEXT NOT NULL,
  month TEXT NOT NULL,
  ota TEXT NOT NULL,
  metric TEXT NOT NULL,
  value NUMERIC,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(facility, month, ota, metric)
);

-- ========================================
-- Mart層ビュー
-- ========================================

CREATE OR REPLACE VIEW mart_monthly_kpi AS
SELECT
  r.facility,
  TO_CHAR(r.checkin, 'YYYY-MM') AS month,
  SUM(r.revenue_settled) AS revenue,
  SUM(r.nights) AS rooms_sold,
  SUM(r.guests_total) AS guests,
  CASE WHEN b.total_inventory > 0
    THEN ROUND(SUM(r.nights)::NUMERIC / b.total_inventory, 4) END AS occ,
  CASE WHEN SUM(r.nights) > 0
    THEN ROUND(SUM(r.revenue_settled)::NUMERIC / SUM(r.nights)) END AS adr,
  CASE WHEN SUM(r.guests_total) > 0
    THEN ROUND(SUM(r.revenue_settled)::NUMERIC / SUM(r.guests_total)) END AS guest_unit,
  CASE WHEN b.total_inventory > 0
    THEN ROUND(SUM(r.revenue_settled)::NUMERIC / b.total_inventory) END AS revpar,
  CASE WHEN SUM(r.nights) > 0
    THEN ROUND(SUM(r.guests_total)::NUMERIC / SUM(r.nights), 2) END AS companion,
  b.revenue_budget,
  b.total_inventory
FROM raw_reservation r
LEFT JOIN dim_budget b ON r.facility = b.facility
  AND TO_CHAR(r.checkin, 'YYYY-MM') = b.month
WHERE r.status = 'C/O' AND r.nights > 0
GROUP BY r.facility, TO_CHAR(r.checkin, 'YYYY-MM'),
  b.total_inventory, b.revenue_budget;

CREATE OR REPLACE VIEW mart_channel_monthly AS
SELECT
  facility,
  TO_CHAR(checkin, 'YYYY-MM') AS month,
  channel,
  SUM(revenue_settled) AS revenue,
  SUM(nights) AS rooms,
  SUM(guests_total) AS guests,
  CASE WHEN SUM(nights) > 0
    THEN ROUND(SUM(revenue_settled)::NUMERIC / SUM(nights)) END AS adr,
  CASE WHEN SUM(guests_total) > 0
    THEN ROUND(SUM(revenue_settled)::NUMERIC / SUM(guests_total)) END AS guest_unit
FROM raw_reservation
WHERE status = 'C/O' AND nights > 0
GROUP BY facility, TO_CHAR(checkin, 'YYYY-MM'), channel;

CREATE OR REPLACE VIEW mart_daily AS
SELECT
  r.facility,
  r.checkin AS date,
  TO_CHAR(r.checkin, 'Dy') AS dow,
  SUM(r.nights) AS rooms_sold,
  SUM(r.revenue_settled) AS revenue,
  SUM(r.guests_total) AS guests,
  CASE WHEN f.total_rooms > 0
    THEN ROUND(SUM(r.nights)::NUMERIC / f.total_rooms, 4) END AS occ,
  CASE WHEN SUM(r.nights) > 0
    THEN ROUND(SUM(r.revenue_settled)::NUMERIC / SUM(r.nights)) END AS adr,
  CASE WHEN SUM(r.guests_total) > 0
    THEN ROUND(SUM(r.revenue_settled)::NUMERIC / SUM(r.guests_total)) END AS guest_unit,
  CASE WHEN f.total_rooms > 0
    THEN ROUND(SUM(r.revenue_settled)::NUMERIC / f.total_rooms) END AS revpar
FROM raw_reservation r
LEFT JOIN dim_facility f ON r.facility = f.facility
WHERE r.status = 'C/O' AND r.nights > 0
GROUP BY r.facility, r.checkin, f.total_rooms;

CREATE OR REPLACE VIEW mart_room_monthly AS
SELECT
  facility,
  TO_CHAR(checkin, 'YYYY-MM') AS month,
  room_parsed AS room,
  SUM(revenue_settled) AS revenue,
  SUM(nights) AS rooms_sold,
  SUM(guests_total) AS guests,
  CASE WHEN SUM(nights) > 0
    THEN ROUND(SUM(revenue_settled)::NUMERIC / SUM(nights)) END AS adr,
  CASE WHEN SUM(nights) > 0
    THEN ROUND(SUM(guests_total)::NUMERIC / SUM(nights), 2) END AS companion
FROM raw_reservation
WHERE status = 'C/O' AND nights > 0 AND room_parsed IS NOT NULL
GROUP BY facility, TO_CHAR(checkin, 'YYYY-MM'), room_parsed;

CREATE OR REPLACE VIEW mart_cxl_summary AS
SELECT
  facility,
  TO_CHAR(checkin, 'YYYY-MM') AS month,
  channel,
  COUNT(*) FILTER (WHERE event_type = '予約') AS bookings,
  COUNT(*) FILTER (WHERE event_type = '取消') AS cancels,
  SUM(amount_gross) FILTER (WHERE event_type = '取消') AS cancel_revenue,
  CASE WHEN COUNT(*) > 0
    THEN ROUND(
      COUNT(*) FILTER (WHERE event_type = '取消')::NUMERIC / COUNT(*), 4
    ) END AS cxl_rate
FROM raw_booking_event
WHERE event_type IN ('予約', '取消')
GROUP BY facility, TO_CHAR(checkin, 'YYYY-MM'), channel;

CREATE OR REPLACE VIEW mart_cxl_lt AS
SELECT
  facility,
  TO_CHAR(checkin, 'YYYY-MM') AS month,
  CASE
    WHEN ABS(checkin - received_at) <= 0 THEN '当日'
    WHEN ABS(checkin - received_at) <= 3 THEN '1-3日前'
    WHEN ABS(checkin - received_at) <= 6 THEN '4-6日前'
    WHEN ABS(checkin - received_at) <= 13 THEN '7-13日前'
    WHEN ABS(checkin - received_at) <= 20 THEN '14-20日前'
    WHEN ABS(checkin - received_at) <= 27 THEN '21-27日前'
    WHEN ABS(checkin - received_at) <= 55 THEN '28-55日前'
    WHEN ABS(checkin - received_at) <= 83 THEN '56-83日前'
    WHEN ABS(checkin - received_at) <= 111 THEN '84-111日前'
    ELSE '112日以上前'
  END AS bucket,
  COUNT(*) AS count
FROM raw_booking_event
WHERE event_type = '取消'
GROUP BY facility, TO_CHAR(checkin, 'YYYY-MM'), bucket;

CREATE OR REPLACE VIEW mart_booking_lt AS
SELECT
  facility,
  TO_CHAR(checkin, 'YYYY-MM') AS month,
  CASE
    WHEN ABS(checkin - received_at) <= 6 THEN '0-6日前'
    WHEN ABS(checkin - received_at) <= 13 THEN '7-13日前'
    WHEN ABS(checkin - received_at) <= 20 THEN '14-20日前'
    WHEN ABS(checkin - received_at) <= 27 THEN '21-27日前'
    WHEN ABS(checkin - received_at) <= 55 THEN '28-55日前'
    WHEN ABS(checkin - received_at) <= 83 THEN '56-83日前'
    WHEN ABS(checkin - received_at) <= 111 THEN '84-111日前'
    ELSE '112日以上前'
  END AS bucket,
  SUM(amount_gross) AS revenue,
  SUM(rooms) AS rooms_total,
  SUM(guests_total) AS guests,
  CASE WHEN SUM(rooms) > 0
    THEN ROUND(SUM(amount_gross)::NUMERIC / SUM(rooms)) END AS adr,
  COUNT(*) AS count
FROM raw_booking_event
WHERE event_type = '予約'
GROUP BY facility, TO_CHAR(checkin, 'YYYY-MM'), bucket;

CREATE OR REPLACE VIEW mart_residence_monthly AS
SELECT
  facility,
  TO_CHAR(checkin, 'YYYY-MM') AS month,
  prefecture,
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
  SUM(guests_total) AS guests,
  SUM(revenue_settled) AS revenue,
  CASE WHEN SUM(guests_total) > 0
    THEN ROUND(SUM(revenue_settled)::NUMERIC / SUM(guests_total)) END AS guest_unit
FROM raw_reservation
WHERE status = 'C/O' AND nights > 0 AND prefecture IS NOT NULL
GROUP BY facility, TO_CHAR(checkin, 'YYYY-MM'), prefecture;

CREATE OR REPLACE VIEW mart_gs_monthly AS
SELECT
  facility,
  TO_CHAR(checkin, 'YYYY-MM') AS month,
  CASE
    WHEN ROUND(guests_total::NUMERIC / GREATEST(rooms, 1)) <= 1 THEN '1名'
    WHEN ROUND(guests_total::NUMERIC / GREATEST(rooms, 1)) = 2 THEN '2名'
    WHEN ROUND(guests_total::NUMERIC / GREATEST(rooms, 1)) = 3 THEN '3名'
    WHEN ROUND(guests_total::NUMERIC / GREATEST(rooms, 1)) = 4 THEN '4名'
    ELSE '5名以上'
  END AS group_size,
  COUNT(*) AS bookings,
  SUM(amount_gross) AS revenue,
  SUM(rooms) AS rooms_total,
  CASE WHEN SUM(rooms) > 0
    THEN ROUND(SUM(amount_gross)::NUMERIC / SUM(rooms)) END AS adr
FROM raw_booking_event
WHERE event_type = '予約'
GROUP BY facility, TO_CHAR(checkin, 'YYYY-MM'), group_size;

-- 喫食月次（予約単位）: 各予約の代表喫食タイプを優先順位で決定して集計
CREATE OR REPLACE VIEW mart_meal_monthly AS
WITH res_meal AS (
  SELECT bp.facility, bp.pms_id, TO_CHAR(r.checkin,'YYYY-MM') AS month,
    MIN(CASE bp.meal_type
      WHEN '2食付' THEN 1 WHEN '朝食付' THEN 2 WHEN '夕食のみ' THEN 3 WHEN '素泊り' THEN 4 ELSE 5 END) AS rk,
    MAX(r.revenue_settled) AS revenue, MAX(r.nights) AS nights, MAX(r.guests_total) AS guests
  FROM raw_basic_product bp
  JOIN raw_reservation r ON bp.facility = r.facility AND bp.pms_id = r.pms_id
  WHERE r.status = 'C/O' AND r.nights > 0
  GROUP BY bp.facility, bp.pms_id, TO_CHAR(r.checkin,'YYYY-MM')
)
SELECT facility, month,
  CASE rk WHEN 1 THEN '2食付' WHEN 2 THEN '朝食付' WHEN 3 THEN '夕食のみ' WHEN 4 THEN '素泊り' ELSE 'その他' END AS meal_type,
  COUNT(*) AS reservations, SUM(revenue) AS revenue, SUM(nights) AS rooms, SUM(guests) AS guests
FROM res_meal
GROUP BY facility, month, rk;

-- 部屋タイプ月次（部屋タイプ名の先頭区分で集計）
CREATE OR REPLACE VIEW mart_room_type_monthly AS
SELECT facility, TO_CHAR(checkin,'YYYY-MM') AS month, room_type,
  SUM(revenue_settled) AS revenue, SUM(nights) AS rooms_sold, SUM(guests_total) AS guests,
  CASE WHEN SUM(nights) > 0 THEN ROUND(SUM(revenue_settled)::NUMERIC / SUM(nights)) END AS adr
FROM raw_reservation
WHERE status = 'C/O' AND nights > 0 AND room_type IS NOT NULL
GROUP BY facility, TO_CHAR(checkin,'YYYY-MM'), room_type;

CREATE OR REPLACE VIEW mart_fb_category AS
SELECT
  op.facility,
  TO_CHAR(r.checkin, 'YYYY-MM') AS month,
  op.category,
  SUM(op.total) AS revenue,
  SUM(op.quantity) AS count
FROM raw_other_product op
JOIN raw_reservation r ON op.facility = r.facility AND op.pms_id = r.pms_id
WHERE op.status = 'C/O'
GROUP BY op.facility, TO_CHAR(r.checkin, 'YYYY-MM'), op.category;

-- 確定販売室数ベースの稼働率（日別） — 正データ：販売数集計表
CREATE OR REPLACE VIEW mart_occupancy_daily AS
SELECT
  rs.facility,
  rs.stay_date AS date,
  TO_CHAR(rs.stay_date, 'Dy') AS dow,
  rs.sold AS rooms_sold,
  f.total_rooms,
  CASE WHEN f.total_rooms > 0
    THEN ROUND(rs.sold::NUMERIC / f.total_rooms, 4) END AS occ
FROM raw_room_sales rs
LEFT JOIN dim_facility f ON rs.facility = f.facility
WHERE rs.scope = 'total';

-- 確定販売室数ベースの稼働率（月別）
CREATE OR REPLACE VIEW mart_occupancy_monthly AS
SELECT
  rs.facility,
  rs.source_month AS month,
  SUM(rs.sold) AS rooms_sold,
  COUNT(DISTINCT rs.stay_date) AS operating_days,
  f.total_rooms,
  CASE WHEN f.total_rooms > 0 AND COUNT(DISTINCT rs.stay_date) > 0
    THEN ROUND(SUM(rs.sold)::NUMERIC / (f.total_rooms * COUNT(DISTINCT rs.stay_date)), 4) END AS occ
FROM raw_room_sales rs
LEFT JOIN dim_facility f ON rs.facility = f.facility
WHERE rs.scope = 'total'
GROUP BY rs.facility, rs.source_month, f.total_rooms;

-- 客室タイプ別 販売室数（月別）
CREATE OR REPLACE VIEW mart_room_sales_type_monthly AS
SELECT
  facility,
  source_month AS month,
  room_type,
  SUM(sold) AS rooms_sold
FROM raw_room_sales
WHERE scope = 'type'
GROUP BY facility, source_month, room_type;

-- プラン月次（Lincoln予約由来）
CREATE OR REPLACE VIEW mart_plan_monthly AS
SELECT facility, TO_CHAR(checkin,'YYYY-MM') AS month, plan,
  COUNT(*) AS bookings,
  SUM(amount_gross) AS revenue,
  SUM(rooms) AS rooms_total,
  SUM(guests_total) AS guests,
  CASE WHEN SUM(rooms) > 0 THEN ROUND(SUM(amount_gross)::NUMERIC / SUM(rooms)) END AS adr
FROM raw_booking_event
WHERE event_type = '予約' AND plan IS NOT NULL AND plan <> ''
GROUP BY facility, TO_CHAR(checkin,'YYYY-MM'), plan;

-- ADR帯月次（Lincoln予約由来）
CREATE OR REPLACE VIEW mart_adr_band_monthly AS
SELECT facility, TO_CHAR(checkin,'YYYY-MM') AS month,
  CASE
    WHEN amount_gross::NUMERIC / GREATEST(rooms,1) < 30000 THEN '〜¥30K'
    WHEN amount_gross::NUMERIC / GREATEST(rooms,1) < 50000 THEN '¥30-50K'
    WHEN amount_gross::NUMERIC / GREATEST(rooms,1) < 70000 THEN '¥50-70K'
    WHEN amount_gross::NUMERIC / GREATEST(rooms,1) < 100000 THEN '¥70-100K'
    ELSE '¥100K〜'
  END AS band,
  COUNT(*) AS bookings,
  SUM(amount_gross) AS revenue,
  SUM(rooms) AS rooms_total,
  CASE WHEN SUM(rooms) > 0 THEN ROUND(SUM(amount_gross)::NUMERIC / SUM(rooms)) END AS adr
FROM raw_booking_event
WHERE event_type = '予約' AND rooms > 0
GROUP BY facility, TO_CHAR(checkin,'YYYY-MM'), band;

-- ========================================
-- Row Level Security（全開放）
-- ========================================

ALTER TABLE raw_reservation ENABLE ROW LEVEL SECURITY;
CREATE POLICY "allow_all_authenticated" ON raw_reservation
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

ALTER TABLE raw_basic_product ENABLE ROW LEVEL SECURITY;
CREATE POLICY "allow_all_authenticated" ON raw_basic_product
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

ALTER TABLE raw_other_product ENABLE ROW LEVEL SECURITY;
CREATE POLICY "allow_all_authenticated" ON raw_other_product
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

ALTER TABLE raw_payment ENABLE ROW LEVEL SECURITY;
CREATE POLICY "allow_all_authenticated" ON raw_payment
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

ALTER TABLE raw_booking_event ENABLE ROW LEVEL SECURITY;
CREATE POLICY "allow_all_authenticated" ON raw_booking_event
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

ALTER TABLE raw_rate_snapshot ENABLE ROW LEVEL SECURITY;
CREATE POLICY "allow_all_authenticated" ON raw_rate_snapshot
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

ALTER TABLE raw_room_sales ENABLE ROW LEVEL SECURITY;
CREATE POLICY "allow_all_authenticated" ON raw_room_sales
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

ALTER TABLE dim_facility ENABLE ROW LEVEL SECURITY;
CREATE POLICY "allow_all_authenticated" ON dim_facility
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

ALTER TABLE dim_budget ENABLE ROW LEVEL SECURITY;
CREATE POLICY "allow_all_authenticated" ON dim_budget
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

ALTER TABLE dim_ota_marketing ENABLE ROW LEVEL SECURITY;
CREATE POLICY "allow_all_authenticated" ON dim_ota_marketing
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- ========================================
-- 予算（スプレッドシート連携）
-- ========================================
CREATE TABLE IF NOT EXISTS budget_daily (
  id BIGSERIAL PRIMARY KEY,
  facility TEXT NOT NULL, fiscal_year TEXT NOT NULL, date DATE NOT NULL,
  event_note TEXT, inventory INTEGER, rooms_sold NUMERIC, occ NUMERIC, companion NUMERIC,
  guests NUMERIC, guest_unit NUMERIC, room_unit NUMERIC, room_revenue NUMERIC,
  shop_revenue NUMERIC, beverage_revenue NUMERIC, extra_food_revenue NUMERIC,
  daytrip_revenue NUMERIC, other_revenue NUMERIC, ancillary_revenue NUMERIC, total_revenue NUMERIC,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(facility, date)
);
CREATE INDEX IF NOT EXISTS idx_budget_daily_fac_date ON budget_daily(facility, date);

CREATE TABLE IF NOT EXISTS budget_monthly (
  id BIGSERIAL PRIMARY KEY,
  facility TEXT NOT NULL, fiscal_year TEXT NOT NULL, month TEXT NOT NULL,
  category TEXT, item_code TEXT NOT NULL, item_name TEXT NOT NULL,
  amount NUMERIC, ratio NUMERIC, sort_order INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(facility, fiscal_year, month, item_code)
);
CREATE INDEX IF NOT EXISTS idx_budget_monthly_fac_month ON budget_monthly(facility, month);

CREATE TABLE IF NOT EXISTS actual_monthly (
  id BIGSERIAL PRIMARY KEY,
  facility TEXT NOT NULL, fiscal_year TEXT NOT NULL, month TEXT NOT NULL,
  category TEXT, item_code TEXT NOT NULL, item_name TEXT NOT NULL,
  actual NUMERIC, prior_amount NUMERIC,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(facility, fiscal_year, month, item_code)
);
CREATE INDEX IF NOT EXISTS idx_actual_monthly_fac_month ON actual_monthly(facility, month);

CREATE OR REPLACE VIEW mart_budget_revenue_monthly AS
SELECT facility, month, amount AS revenue_budget
FROM budget_monthly WHERE item_code = 'sales_total';

ALTER TABLE actual_monthly ENABLE ROW LEVEL SECURITY;
CREATE POLICY "allow_all_authenticated" ON actual_monthly FOR ALL TO authenticated USING (true) WITH CHECK (true);
ALTER TABLE budget_daily ENABLE ROW LEVEL SECURITY;
CREATE POLICY "allow_all_authenticated" ON budget_daily FOR ALL TO authenticated USING (true) WITH CHECK (true);
ALTER TABLE budget_monthly ENABLE ROW LEVEL SECURITY;
CREATE POLICY "allow_all_authenticated" ON budget_monthly FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- 概要のAIサマリ キャッシュ（月が変わった時だけ生成）
CREATE TABLE IF NOT EXISTS ai_summary (
  id BIGSERIAL PRIMARY KEY,
  facility TEXT NOT NULL, month TEXT NOT NULL, content TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(facility, month)
);
ALTER TABLE ai_summary ENABLE ROW LEVEL SECURITY;
CREATE POLICY "allow_all_authenticated" ON ai_summary FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- ========================================
-- FRY初期データ
-- ========================================

INSERT INTO dim_facility (facility, name, short_name, total_rooms)
VALUES ('FRY', '山の手ホテル', 'FRY', NULL)
ON CONFLICT (facility) DO NOTHING;
`;

async function migrate() {
  console.log('Connecting to Supabase PostgreSQL...');
  await client.connect();
  console.log('Connected. Running migration...');

  try {
    await client.query(DDL);
    console.log('Migration completed successfully!');

    const tables = await client.query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      ORDER BY table_name
    `);
    console.log('\nTables created:');
    tables.rows.forEach(r => console.log('  -', r.table_name));

    const views = await client.query(`
      SELECT table_name FROM information_schema.views
      WHERE table_schema = 'public'
      ORDER BY table_name
    `);
    console.log('\nViews created:');
    views.rows.forEach(r => console.log('  -', r.table_name));

    const fry = await client.query(`SELECT * FROM dim_facility WHERE facility = 'FRY'`);
    console.log('\nFRY record:', fry.rows[0]);
  } catch (err) {
    console.error('Migration error:', err.message);
    throw err;
  } finally {
    await client.end();
  }
}

migrate();
