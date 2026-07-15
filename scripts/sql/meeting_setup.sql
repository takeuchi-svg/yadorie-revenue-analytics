-- ============================================================
--  月次会議（B10）: 会議記録テーブル ＋ 課題認識列
--  Supabase SQL Editor で全文 Run（冪等）
--
--  設計:
--  - 会議で話したことは「自由記述」で受ける（フォーム化しない＝豊かさを殺さない）。
--    構造化は灯(meeting_extract)がやり、人が承認して既存の器(取組履歴/プロフィール)へ登録。
--  - タスクは記録のみ（担当者・期限・完了ステータスの追跡はしない）。
--  - RLSは既存の宿スコープ標準 can_access_facility を踏襲。
-- ============================================================

create table if not exists raw_meeting_record (
  id           bigserial primary key,
  facility     text not null references dim_facility(facility),
  year_month   text not null,               -- 'YYYY-MM'（対象月）
  meeting_date date,                         -- 開催日
  attendees    text,                         -- 参加者（自由記述）
  review_note  text,                         -- 実績の振り返り（自由記述）
  discussion_note text,                      -- 議論したいこと・議論内容（自由記述）
  decision_note text,                        -- 決定事項（自由記述）
  task_note    text,                         -- タスク事項（自由記述・記録のみ）
  created_at   timestamptz default now(),
  updated_at   timestamptz default now(),
  created_by   text,
  unique (facility, year_month)
);

alter table raw_meeting_record enable row level security;
drop policy if exists "meeting_record_facility_scope" on raw_meeting_record;
create policy "meeting_record_facility_scope" on raw_meeting_record
  for all to authenticated
  using (public.can_access_facility(facility))
  with check (public.can_access_facility(facility));

-- 構造化抽出の「課題認識」書き戻し先。dim_facility_profile に専用列が無いため追加（意図・方針と並ぶ）。
alter table dim_facility_profile add column if not exists issue_awareness text;
comment on column dim_facility_profile.issue_awareness is '課題認識（支配人が認識している課題。月次会議の構造化抽出からも追記される）';

-- 確認: select facility, year_month, meeting_date from raw_meeting_record order by year_month desc limit 5;
-- ロールバック: drop table if exists raw_meeting_record; alter table dim_facility_profile drop column if exists issue_awareness;
