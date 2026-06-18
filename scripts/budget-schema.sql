-- ============================================================
-- 予算（スプレッドシート連携）テーブル
--   budget_daily   ← ③日別計画
--   budget_monthly ← ⑤月次計画（フルP&L, EAV）
-- Supabase SQL Editor で実行してください。
-- ============================================================

CREATE TABLE IF NOT EXISTS budget_daily (
  id BIGSERIAL PRIMARY KEY,
  facility TEXT NOT NULL,
  fiscal_year TEXT NOT NULL,          -- 年度（例: '2026' = 2026/04〜2027/03）
  date DATE NOT NULL,
  event_note TEXT,                    -- イベント/休館/素泊
  inventory INTEGER,                  -- 在庫数
  rooms_sold NUMERIC,                 -- 販売室数
  occ NUMERIC,                        -- 稼働率
  companion NUMERIC,                  -- 同伴係数
  guests NUMERIC,                     -- 宿泊人数
  guest_unit NUMERIC,                 -- 客単価
  room_unit NUMERIC,                  -- 室単価
  room_revenue NUMERIC,               -- 宿泊売上
  shop_revenue NUMERIC,               -- 売店売上
  beverage_revenue NUMERIC,           -- 飲料売上
  extra_food_revenue NUMERIC,         -- 別注料理売上
  daytrip_revenue NUMERIC,            -- 日帰売上
  other_revenue NUMERIC,              -- その他売上
  ancillary_revenue NUMERIC,          -- 付帯売上
  total_revenue NUMERIC,              -- 売上合計
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(facility, date)
);
CREATE INDEX IF NOT EXISTS idx_budget_daily_fac_date ON budget_daily(facility, date);

CREATE TABLE IF NOT EXISTS budget_monthly (
  id BIGSERIAL PRIMARY KEY,
  facility TEXT NOT NULL,
  fiscal_year TEXT NOT NULL,
  month TEXT NOT NULL,                -- 'YYYY-MM'
  category TEXT,                      -- 大分類: 売上/原価/人件費/販売管理費/GOP/EBITDA/営業損益 等
  item_code TEXT NOT NULL,            -- 安定キー（項目名スラッグ）
  item_name TEXT NOT NULL,            -- 表示名（売上高計, 宿泊売上, ...）
  amount NUMERIC,                     -- 金額
  ratio NUMERIC,                      -- 対売上比
  sort_order INTEGER,                 -- 表示順
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(facility, fiscal_year, month, item_code)
);
CREATE INDEX IF NOT EXISTS idx_budget_monthly_fac_month ON budget_monthly(facility, month);

-- RLS（認証ユーザー全開放: 既存テーブルと同方針）
ALTER TABLE budget_daily ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "allow_all_authenticated" ON budget_daily;
CREATE POLICY "allow_all_authenticated" ON budget_daily FOR ALL TO authenticated USING (true) WITH CHECK (true);

ALTER TABLE budget_monthly ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "allow_all_authenticated" ON budget_monthly;
CREATE POLICY "allow_all_authenticated" ON budget_monthly FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- 月次売上予算ビュー（Overviewの予算達成率などで利用）
CREATE OR REPLACE VIEW mart_budget_revenue_monthly AS
SELECT facility, month, amount AS revenue_budget
FROM budget_monthly
WHERE item_code = 'sales_total';
