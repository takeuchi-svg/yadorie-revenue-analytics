-- ============================================================
-- 生産性KPI機能  スキーマ  （Supabase SQL Editor で実行）
--   勤怠CSV（Touch On Time / HTML）→ raw_attendance_daily
--   労働時間の月次集計 → mart_labor_monthly（ビュー）
--   生産性KPIの分子（売上/客数/室数）は既存 mart_monthly_kpi、
--   人件費/付加価値は actual_monthly、手動入力は dim_productivity_manual。
--   ※生産性KPI自体はフロント側で集計（yojitsuと同方式）。
-- ============================================================

-- ------------------------------------------------------------
-- 1) 施設マッピング（勤怠所属コード → BI施設コード）※パーサーはTS定数を使用。本表は参照/将来用
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dim_facility_mapping (
  attendance_code TEXT PRIMARY KEY,   -- "121"
  attendance_name TEXT,                -- "山の手ホテル"
  facility TEXT,                        -- "FRY"（本社部門は 'HQ'）
  is_facility BOOLEAN DEFAULT TRUE      -- 施設=true / 本社部門=false
);

INSERT INTO dim_facility_mapping (attendance_code, attendance_name, facility, is_facility) VALUES
  ('102','旅館ぬしや','NS',true),
  ('103','旅館岐山','GZ',true),
  ('104','木曽駒高原 森のホテル','MH',true),
  ('105','海遊亭','KT',true),
  ('106','OQOQ','OQ',true),
  ('107','安比高原 森のホテル','AP',true),
  ('108','伊豆高原温泉ホテル 森の泉','MI',true),
  ('110','つるや旅館','TR',true),
  ('111','一久旅館','IK',true),
  ('112','Onn中津川','ON',true),
  ('113','Onn湯田温泉','OY',true),
  ('114','ゆずり葉','YZ',true),
  ('115','笹屋','SY',true),
  ('116','しらはま','SR',true),
  ('117','かたくりの花','KR',true),
  ('118','玉井館','TK',true),
  ('119','baison','BSN',true),
  ('120','湯の季','YNT',true),
  ('121','山の手ホテル','FRY',true),
  ('122','東屋','HGY',true),
  ('123','NOIE','NIE',true),
  ('124','Onn大曲の花火','OOH',true),
  ('125','マリーンホテルはりも','HRM',true),
  ('126','かじか','KJK',true),
  ('127','小谷の湯','AOY',true),
  ('128','かめや','KMY',true),
  ('129','森本','MRM',true),
  ('100','本社','HQ',false),
  ('1000','運営事業部','HQ',false),
  ('1001','経営企画課','HQ',false),
  ('1002','人事労務課','HQ',false),
  ('1003','マーケティング課','HQ',false),
  ('1004','事業開発課','HQ',false),
  ('1006','経理課','HQ',false),
  ('1007','運営管理課','HQ',false),
  ('1008','コンサル事業部','HQ',false)
ON CONFLICT (attendance_code) DO UPDATE
  SET attendance_name = EXCLUDED.attendance_name,
      facility = EXCLUDED.facility,
      is_facility = EXCLUDED.is_facility;

-- ------------------------------------------------------------
-- 2) 従業員マスタ（勤怠取込時に自動upsert）
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dim_staff (
  staff_code TEXT PRIMARY KEY,         -- "532"
  name TEXT,                            -- "池田 真知子"
  home_facility TEXT,                   -- 本務施設（BIコード。本社は 'HQ'）
  employment_type TEXT,                 -- "正社員" | "アルバイト"
  is_monthly_salary BOOLEAN,            -- 月給=true / 時給=false
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ------------------------------------------------------------
-- 3) 日次勤怠（労働時間の生データ。すべて分単位の整数で格納）
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS raw_attendance_daily (
  id BIGSERIAL PRIMARY KEY,
  staff_code TEXT NOT NULL,
  work_date DATE NOT NULL,
  work_facility TEXT,           -- 計上先施設（ヘルプ先含む。BIコード）
  home_dept TEXT,               -- 本務部門（BIコード。ヘルプ判定用）
  employment_type TEXT,         -- 正社員 / アルバイト
  is_help BOOLEAN DEFAULT FALSE,
  day_type TEXT,                -- 勤務日種別（平日/休日等）
  clock_in TIME,
  clock_out TIME,
  regular_min INTEGER DEFAULT 0,        -- 所定
  overtime_min INTEGER DEFAULT 0,       -- 所定外
  extra_overtime_min INTEGER DEFAULT 0, -- 残業
  night_regular_min INTEGER DEFAULT 0,  -- 深夜所定
  night_ot_min INTEGER DEFAULT 0,       -- 深夜所定外
  night_extra_min INTEGER DEFAULT 0,    -- 深夜残業
  holiday_regular_min INTEGER DEFAULT 0,-- 休日所定
  holiday_ot_min INTEGER DEFAULT 0,     -- 休日所定外
  holiday_extra_min INTEGER DEFAULT 0,  -- 休日残業
  holiday_night_min INTEGER DEFAULT 0,  -- 休日深夜（合算）
  break_min INTEGER DEFAULT 0,          -- 休憩
  total_work_min INTEGER DEFAULT 0,     -- 労働合計（最重要）
  late_min INTEGER DEFAULT 0,           -- 遅刻
  early_min INTEGER DEFAULT 0,          -- 早退
  source_file TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (staff_code, work_date, work_facility)  -- 同日同施設の重複防止（再アップロードでUPSERT）
);

CREATE INDEX IF NOT EXISTS idx_att_facility_date ON raw_attendance_daily (work_facility, work_date);
CREATE INDEX IF NOT EXISTS idx_att_staff_date ON raw_attendance_daily (staff_code, work_date);

ALTER TABLE raw_attendance_daily ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "attendance_all_authenticated" ON raw_attendance_daily;
CREATE POLICY "attendance_all_authenticated" ON raw_attendance_daily
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

ALTER TABLE dim_staff ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "staff_all_authenticated" ON dim_staff;
CREATE POLICY "staff_all_authenticated" ON dim_staff
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

ALTER TABLE dim_facility_mapping ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "facmap_read_authenticated" ON dim_facility_mapping;
CREATE POLICY "facmap_read_authenticated" ON dim_facility_mapping
  FOR SELECT TO authenticated USING (true);

-- ------------------------------------------------------------
-- 4) 手動入力指標（みなし残業超の残業代 / 派遣・その他の労働時間）
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dim_productivity_manual (
  facility TEXT NOT NULL,
  month TEXT NOT NULL,                            -- 'YYYY-MM'
  deemed_overtime_excess_pay INTEGER DEFAULT 0,  -- みなし残業超の残業代（円）
  dispatch_work_hours NUMERIC DEFAULT 0,         -- 派遣・その他の労働時間（時間）
  dispatch_other_notes TEXT,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (facility, month)
);
ALTER TABLE dim_productivity_manual ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "prodmanual_all_authenticated" ON dim_productivity_manual;
CREATE POLICY "prodmanual_all_authenticated" ON dim_productivity_manual
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- ------------------------------------------------------------
-- 5) 労働時間 月次集計ビュー（HQは除外）
-- ------------------------------------------------------------
CREATE OR REPLACE VIEW mart_labor_monthly AS
SELECT
  work_facility AS facility,
  TO_CHAR(work_date, 'YYYY-MM') AS month,
  COUNT(DISTINCT staff_code) FILTER (WHERE employment_type = '正社員')   AS staff_count_monthly,
  COUNT(DISTINCT staff_code) FILTER (WHERE employment_type = 'アルバイト') AS parttime_count,
  ROUND(SUM(total_work_min) / 60.0, 1)                                   AS total_work_hours,
  ROUND(SUM(total_work_min) FILTER (WHERE NOT is_help) / 60.0, 1)        AS own_work_hours,
  ROUND(SUM(total_work_min) FILTER (WHERE is_help) / 60.0, 1)           AS help_work_hours,
  ROUND(SUM(overtime_min + extra_overtime_min + night_extra_min
          + holiday_extra_min) / 60.0, 1)                               AS total_overtime_hours,
  ROUND(SUM(regular_min + holiday_regular_min) / 60.0, 1)               AS regular_hours,
  ROUND(SUM(night_regular_min + night_ot_min + night_extra_min) / 60.0, 1) AS night_hours,
  ROUND(SUM(holiday_regular_min + holiday_ot_min + holiday_extra_min
          + holiday_night_min) / 60.0, 1)                               AS holiday_hours,
  COUNT(DISTINCT work_date)                                             AS operating_days
FROM raw_attendance_daily
WHERE work_facility IS NOT NULL AND work_facility <> 'HQ'
GROUP BY work_facility, TO_CHAR(work_date, 'YYYY-MM');
