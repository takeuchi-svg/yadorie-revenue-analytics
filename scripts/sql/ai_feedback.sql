-- ============================================================
--  改善要望（灯の回答フィードバック）テーブル 第3弾A
--  Supabase SQL Editor で全文 Run（冪等）
--
--  用途: 灯の回答が不満なとき、支配人がワンクリックで「質問＋回答＋一言」を送信。
--        オーナー（克樹さん）が /knowledge の「改善要望」タブで閲覧・対応。
--  送信=全ユーザー（APIのservice_role経由）／閲覧=owner。
-- ============================================================

create table if not exists ai_feedback (
  id BIGSERIAL primary key,
  facility TEXT,
  created_by TEXT,                 -- 送信者メール
  source TEXT not null check (source in ('chat','summary','issue')),
  question TEXT,                   -- 対象の質問（chat）や対象名（summary/issue）
  answer TEXT,                     -- 灯の回答本文
  comment TEXT,                    -- 送信者の一言（任意）
  status TEXT not null default 'new' check (status in ('new','reviewing','done')),
  owner_note TEXT,                 -- オーナーの対応メモ
  created_at TIMESTAMPTZ default now(),
  updated_at TIMESTAMPTZ default now()
);
create index if not exists ai_feedback_status_idx on ai_feedback(status, created_at desc);

alter table ai_feedback enable row level security;
do $$
declare pol record;
begin
  for pol in select policyname from pg_policies where schemaname='public' and tablename='ai_feedback' loop
    execute format('drop policy %I on ai_feedback', pol.policyname);
  end loop;
end $$;
-- 閲覧=owner のみ。書き込みは API(service_role) 経由（ポリシー無し＝直書き不可）
create policy ai_feedback_view on ai_feedback for select to authenticated
  using (public.role_rank(public.my_role()) >= public.role_rank('owner'));

-- 確認: select status, count(*) from ai_feedback group by status;
-- ロールバック: drop table if exists ai_feedback cascade;
