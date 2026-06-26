-- ============================================================
-- 施設の定性コンテキスト（AI分析の前提情報）  Supabase SQL Editor で実行
--   設定画面で施設ごとに編集。AIサマリ/課題と対策/チャットのプロンプトに注入される。
-- ============================================================
CREATE TABLE IF NOT EXISTS dim_facility_context (
  facility TEXT PRIMARY KEY,
  concept TEXT,        -- コンセプト/ターゲット層
  initiatives TEXT,    -- 直近の取組・施策
  notes TEXT,          -- その他メモ（季節要因・制約等）
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE dim_facility_context ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "faccontext_all_authenticated" ON dim_facility_context;
CREATE POLICY "faccontext_all_authenticated" ON dim_facility_context
  FOR ALL TO authenticated USING (true) WITH CHECK (true);
