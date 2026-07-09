-- ============================================================
--  会話メモリ（灯のチャット履歴）第3弾 M-1
--  Supabase SQL Editor で全文 Run（冪等）
--
--  用途: チャットを (ユーザー × 施設) 単位で永続化。ドロワーを開くと直近を復元し、
--        灯は前回の続きから話せる。「新しい相談」で active=false にして区切る（過去は残す）。
--  閲覧=自分の会話のみ（直読み防御）。書き込みは API(service_role) 経由。
-- ============================================================

create table if not exists chat_message (
  id BIGSERIAL primary key,
  user_id UUID not null,
  facility TEXT,
  role TEXT not null check (role in ('user','assistant')),
  content TEXT not null,
  active BOOLEAN not null default true,   -- false=「新しい相談」で区切った過去分（復元対象外・残す）
  created_at TIMESTAMPTZ default now()
);
create index if not exists chat_message_thread_idx on chat_message(user_id, facility, active, created_at);

alter table chat_message enable row level security;
do $$
declare pol record;
begin
  for pol in select policyname from pg_policies where schemaname='public' and tablename='chat_message' loop
    execute format('drop policy %I on chat_message', pol.policyname);
  end loop;
end $$;
-- 自分の会話のみ閲覧可（書き込みは service_role のみ＝ポリシー無し）
create policy chat_message_own on chat_message for select to authenticated
  using (user_id = auth.uid());

-- 確認: select facility, count(*) from chat_message where active group by facility;
-- ロールバック: drop table if exists chat_message cascade;
