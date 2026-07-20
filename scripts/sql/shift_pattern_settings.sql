-- ============================================================
--  シフトパターン(dim_shift_pattern)を「各宿設定」で編集可能にする  Supabase SQL Editor で Run（冪等）
--  方針: 施設固有パターン(facility = 宿) = その宿メンバーが追加/編集/削除可。
--        全社共通パターン(facility IS NULL) = admin のみ。閲覧は全員。
--  ※ rls_facility.sql の master 扱い(admin書込のみ)を上書きする。rls_facility.sql 側の master 配列からも
--    dim_shift_pattern を外したので、rls を再実行しても本ポリシーは維持される。
-- ============================================================

alter table dim_shift_pattern enable row level security;

-- rls_facility.sql の master ポリシー(存在すれば)を除去
drop policy if exists dim_shift_pattern_read_all on dim_shift_pattern;
drop policy if exists dim_shift_pattern_write_admin_i on dim_shift_pattern;
drop policy if exists dim_shift_pattern_write_admin_u on dim_shift_pattern;
drop policy if exists dim_shift_pattern_write_admin_d on dim_shift_pattern;
drop policy if exists dim_shift_pattern_read on dim_shift_pattern;
drop policy if exists dim_shift_pattern_write on dim_shift_pattern;

-- 閲覧: 全員（全社共通＋各宿のパターンを参照）
create policy dim_shift_pattern_read on dim_shift_pattern
  for select to authenticated using (true);

-- 追加/編集/削除: 施設固有=その宿にアクセス権のあるユーザー / 全社共通(null)=adminのみ
create policy dim_shift_pattern_write on dim_shift_pattern
  for all to authenticated
  using ((facility is not null and public.can_access_facility(facility)) or public.is_admin())
  with check ((facility is not null and public.can_access_facility(facility)) or public.is_admin());

-- 確認: select facility, count(*) from dim_shift_pattern group by facility order by facility nulls first;
