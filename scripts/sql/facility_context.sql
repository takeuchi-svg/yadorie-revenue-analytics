-- ============================================================
-- 施設の定性コンテキスト（AI分析の前提情報）  Supabase SQL Editor で実行
--   設定画面で施設ごとに編集。AIサマリ/課題と対策/チャットのプロンプトに注入される。
--   Googleドキュメント連携: 設定の「同期」でdoc_contentに本文を取り込む（上書き）。
-- ============================================================
CREATE TABLE IF NOT EXISTS dim_facility_context (
  facility TEXT PRIMARY KEY,
  concept TEXT,          -- コンセプト/ターゲット層
  initiatives TEXT,      -- 直近の取組・施策
  notes TEXT,            -- その他メモ（季節要因・制約等）
  doc_url TEXT,          -- 連携するGoogleドキュメントのURL
  doc_content TEXT,      -- 同期で取り込んだ本文（上書き）
  doc_synced_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
-- 既存テーブルへの追加（初版を作成済みの場合）
ALTER TABLE dim_facility_context ADD COLUMN IF NOT EXISTS doc_url TEXT;
ALTER TABLE dim_facility_context ADD COLUMN IF NOT EXISTS doc_content TEXT;
ALTER TABLE dim_facility_context ADD COLUMN IF NOT EXISTS doc_synced_at TIMESTAMPTZ;

ALTER TABLE dim_facility_context ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "faccontext_all_authenticated" ON dim_facility_context;
CREATE POLICY "faccontext_all_authenticated" ON dim_facility_context
  FOR ALL TO authenticated USING (true) WITH CHECK (true);
