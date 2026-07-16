-- ============================================================
--  月次会議: 会議記録を「7カテゴリ × 4軸」のグリッドで持つ（JSONB）
--  Supabase SQL Editor で全文 Run（冪等）
--  前提: meeting_setup.sql 適用済み
--
--  grid = { "<categoryKey>": { "review": "...", "forecast": "...", "agenda": "...", "memo": "..." }, ... }
--  カテゴリ/軸のキーはフロント（components/meeting-tab.tsx）と一致。
--  旧 review_note/discussion_note/decision_note/task_note 列は残置（未使用・後方互換）。
-- ============================================================

alter table raw_meeting_record add column if not exists grid jsonb;
comment on column raw_meeting_record.grid is '会議記録グリッド(7カテゴリ×4軸の自由記述)。{categoryKey:{review,forecast,agenda,memo}}';

-- 確認: select facility, year_month, jsonb_object_keys(grid) from raw_meeting_record limit 20;
