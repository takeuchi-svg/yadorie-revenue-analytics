-- ============================================================
-- アカウント発行 / 施設別権限  (Supabase SQL Editor で実行)
-- ============================================================

-- アプリ利用ユーザー（auth.users と 1:1, role で管理者判定）
CREATE TABLE IF NOT EXISTS app_user (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email TEXT,
  role TEXT NOT NULL DEFAULT 'member', -- 'admin' | 'member'
  created_at TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE app_user ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "app_user_self_read" ON app_user;
CREATE POLICY "app_user_self_read" ON app_user FOR SELECT TO authenticated USING (true);

-- ユーザーが閲覧できる施設（member のみ意味を持つ。admin は全施設）
CREATE TABLE IF NOT EXISTS user_facility (
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  facility TEXT NOT NULL,
  PRIMARY KEY (user_id, facility)
);
ALTER TABLE user_facility ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "user_facility_self_read" ON user_facility;
CREATE POLICY "user_facility_self_read" ON user_facility FOR SELECT TO authenticated USING (true);

-- 既存の認証ユーザー（takeuchi@okamijuku.com 等）を全員 admin としてシード
INSERT INTO app_user (user_id, email, role)
SELECT id, email, 'admin' FROM auth.users
ON CONFLICT (user_id) DO NOTHING;
