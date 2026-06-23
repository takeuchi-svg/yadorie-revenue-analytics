-- ============================================================
-- 稼働日数マスタ（予実管理の在庫数算出に使用）  Supabase SQL Editor で実行
--   在庫数 = 総客室数 × 稼働日数
-- ============================================================
CREATE TABLE IF NOT EXISTS dim_operating_days (
  facility TEXT NOT NULL,
  month TEXT NOT NULL,          -- 'YYYY-MM'
  days INT,                     -- その月の稼働日数（手動入力）
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (facility, month)
);
ALTER TABLE dim_operating_days ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "operating_days_all_authenticated" ON dim_operating_days;
CREATE POLICY "operating_days_all_authenticated" ON dim_operating_days
  FOR ALL TO authenticated USING (true) WITH CHECK (true);
