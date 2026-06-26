-- ============================================================
-- AI分析「課題と対策（参考）」キャッシュ  （Supabase SQL Editor で実行）
--   概要ページの2つ目のAIブロック用。ai_summary と同形。
-- ============================================================
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
CREATE POLICY "ai_issue_all_authenticated" ON ai_issue
  FOR ALL TO authenticated USING (true) WITH CHECK (true);
