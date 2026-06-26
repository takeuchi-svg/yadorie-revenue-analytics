-- ============================================================
-- YADORIE Revenue Analytics  カスタムDBセットアップ（統合版）
--   Supabase SQL Editor にこの全文を貼り付けて Run（何度実行しても安全）
--   含む: アカウント権限 / 稼働日数 / 生産性KPI(勤怠) / AI課題キャッシュ
-- ============================================================

-- ------------------------------------------------------------
-- [1] アカウント発行 / 施設別権限
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app_user (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email TEXT,
  role TEXT NOT NULL DEFAULT 'member',   -- 'admin' | 'member'
  created_at TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE app_user ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "app_user_self_read" ON app_user;
CREATE POLICY "app_user_self_read" ON app_user FOR SELECT TO authenticated USING (true);

CREATE TABLE IF NOT EXISTS user_facility (
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  facility TEXT NOT NULL,
  PRIMARY KEY (user_id, facility)
);
ALTER TABLE user_facility ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "user_facility_self_read" ON user_facility;
CREATE POLICY "user_facility_self_read" ON user_facility FOR SELECT TO authenticated USING (true);

-- 既存の認証ユーザーを全員 admin としてシード
INSERT INTO app_user (user_id, email, role)
SELECT id, email, 'admin' FROM auth.users
ON CONFLICT (user_id) DO NOTHING;

-- ------------------------------------------------------------
-- [2] 稼働日数マスタ（予実管理の在庫数算出: 在庫数 = 総客室数 × 稼働日数）
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dim_operating_days (
  facility TEXT NOT NULL,
  month TEXT NOT NULL,          -- 'YYYY-MM'
  days INT,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (facility, month)
);
ALTER TABLE dim_operating_days ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "operating_days_all_authenticated" ON dim_operating_days;
CREATE POLICY "operating_days_all_authenticated" ON dim_operating_days
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- ------------------------------------------------------------
-- [3] 生産性KPI（勤怠取込）
-- ------------------------------------------------------------
-- 3-1) 施設マッピング（勤怠所属コード → BI施設コード）※参照/将来用。パーサーはTS定数が正
CREATE TABLE IF NOT EXISTS dim_facility_mapping (
  attendance_code TEXT PRIMARY KEY,
  attendance_name TEXT,
  facility TEXT,
  is_facility BOOLEAN DEFAULT TRUE
);
INSERT INTO dim_facility_mapping (attendance_code, attendance_name, facility, is_facility) VALUES
  ('102','旅館ぬしや','NS',true),('103','旅館岐山','GZ',true),('104','木曽駒高原 森のホテル','MH',true),
  ('105','海遊亭','KT',true),('106','OQOQ','OQ',true),('107','安比高原 森のホテル','AP',true),
  ('108','伊豆高原温泉ホテル 森の泉','MI',true),('110','つるや旅館','TR',true),('111','一久旅館','IK',true),
  ('112','Onn中津川','ON',true),('113','Onn湯田温泉','OY',true),('114','ゆずり葉','YZ',true),
  ('115','笹屋','SY',true),('116','しらはま','SR',true),('117','かたくりの花','KR',true),
  ('118','玉井館','TK',true),('119','baison','BSN',true),('120','湯の季','YNT',true),
  ('121','山の手ホテル','FRY',true),('122','東屋','HGY',true),('123','NOIE','NIE',true),
  ('124','Onn大曲の花火','OOH',true),('125','マリーンホテルはりも','HRM',true),('126','かじか','KJK',true),
  ('127','小谷の湯','AOY',true),('128','かめや','KMY',true),('129','森本','MRM',true),
  ('100','本社','HQ',false),('1000','運営事業部','HQ',false),('1001','経営企画課','HQ',false),
  ('1002','人事労務課','HQ',false),('1003','マーケティング課','HQ',false),('1004','事業開発課','HQ',false),
  ('1006','経理課','HQ',false),('1007','運営管理課','HQ',false),('1008','コンサル事業部','HQ',false)
ON CONFLICT (attendance_code) DO UPDATE
  SET attendance_name = EXCLUDED.attendance_name, facility = EXCLUDED.facility, is_facility = EXCLUDED.is_facility;
ALTER TABLE dim_facility_mapping ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "facmap_read_authenticated" ON dim_facility_mapping;
CREATE POLICY "facmap_read_authenticated" ON dim_facility_mapping FOR SELECT TO authenticated USING (true);

-- 3-2) 従業員マスタ（勤怠取込時に自動upsert）
CREATE TABLE IF NOT EXISTS dim_staff (
  staff_code TEXT PRIMARY KEY,
  name TEXT,
  home_facility TEXT,
  employment_type TEXT,
  is_monthly_salary BOOLEAN,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE dim_staff ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "staff_all_authenticated" ON dim_staff;
CREATE POLICY "staff_all_authenticated" ON dim_staff FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- 3-3) 日次勤怠（労働時間。すべて分単位の整数）
CREATE TABLE IF NOT EXISTS raw_attendance_daily (
  id BIGSERIAL PRIMARY KEY,
  staff_code TEXT NOT NULL,
  work_date DATE NOT NULL,
  work_facility TEXT,
  home_dept TEXT,
  employment_type TEXT,
  is_help BOOLEAN DEFAULT FALSE,
  day_type TEXT,
  clock_in TIME,
  clock_out TIME,
  regular_min INTEGER DEFAULT 0,
  overtime_min INTEGER DEFAULT 0,
  extra_overtime_min INTEGER DEFAULT 0,
  night_regular_min INTEGER DEFAULT 0,
  night_ot_min INTEGER DEFAULT 0,
  night_extra_min INTEGER DEFAULT 0,
  holiday_regular_min INTEGER DEFAULT 0,
  holiday_ot_min INTEGER DEFAULT 0,
  holiday_extra_min INTEGER DEFAULT 0,
  holiday_night_min INTEGER DEFAULT 0,
  break_min INTEGER DEFAULT 0,
  total_work_min INTEGER DEFAULT 0,
  late_min INTEGER DEFAULT 0,
  early_min INTEGER DEFAULT 0,
  source_file TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (staff_code, work_date, work_facility)
);
CREATE INDEX IF NOT EXISTS idx_att_facility_date ON raw_attendance_daily (work_facility, work_date);
CREATE INDEX IF NOT EXISTS idx_att_staff_date ON raw_attendance_daily (staff_code, work_date);
ALTER TABLE raw_attendance_daily ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "attendance_all_authenticated" ON raw_attendance_daily;
CREATE POLICY "attendance_all_authenticated" ON raw_attendance_daily FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- 3-4) 手動入力指標（みなし残業超の残業代 / 派遣・その他の労働時間）
CREATE TABLE IF NOT EXISTS dim_productivity_manual (
  facility TEXT NOT NULL,
  month TEXT NOT NULL,
  deemed_overtime_excess_pay INTEGER DEFAULT 0,
  dispatch_work_hours NUMERIC DEFAULT 0,
  dispatch_other_notes TEXT,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (facility, month)
);
ALTER TABLE dim_productivity_manual ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "prodmanual_all_authenticated" ON dim_productivity_manual;
CREATE POLICY "prodmanual_all_authenticated" ON dim_productivity_manual FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- 3-5) 労働時間 月次集計ビュー（HQ除外）
CREATE OR REPLACE VIEW mart_labor_monthly AS
SELECT
  work_facility AS facility,
  TO_CHAR(work_date, 'YYYY-MM') AS month,
  COUNT(DISTINCT staff_code) FILTER (WHERE employment_type = '正社員')   AS staff_count_monthly,
  COUNT(DISTINCT staff_code) FILTER (WHERE employment_type = 'アルバイト') AS parttime_count,
  ROUND(SUM(total_work_min) / 60.0, 1)                                   AS total_work_hours,
  ROUND(SUM(total_work_min) FILTER (WHERE NOT is_help) / 60.0, 1)        AS own_work_hours,
  ROUND(SUM(total_work_min) FILTER (WHERE is_help) / 60.0, 1)           AS help_work_hours,
  ROUND(SUM(overtime_min + extra_overtime_min + night_extra_min + holiday_extra_min) / 60.0, 1) AS total_overtime_hours,
  ROUND(SUM(regular_min + holiday_regular_min) / 60.0, 1)               AS regular_hours,
  ROUND(SUM(night_regular_min + night_ot_min + night_extra_min) / 60.0, 1) AS night_hours,
  ROUND(SUM(holiday_regular_min + holiday_ot_min + holiday_extra_min + holiday_night_min) / 60.0, 1) AS holiday_hours,
  COUNT(DISTINCT work_date)                                             AS operating_days
FROM raw_attendance_daily
WHERE work_facility IS NOT NULL AND work_facility <> 'HQ'
GROUP BY work_facility, TO_CHAR(work_date, 'YYYY-MM');

-- ------------------------------------------------------------
-- [4] 概要ページ AI「課題と対策（参考）」キャッシュ（ai_summary と同形）
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ai_issue (
  id BIGSERIAL PRIMARY KEY,
  facility TEXT NOT NULL,
  month TEXT NOT NULL,
  content TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (facility, month)
);
ALTER TABLE ai_issue ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ai_issue_all_authenticated" ON ai_issue;
CREATE POLICY "ai_issue_all_authenticated" ON ai_issue FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- ------------------------------------------------------------
-- [5] 廃止: 施設コンテキスト（Googleドキュメント連携）機能の削除
-- ------------------------------------------------------------
DROP TABLE IF EXISTS dim_facility_context;
