-- ============================================================
--  施設タイプ（基準PL照合用）を dim_facility_profile に追加
--  Supabase SQL Editor で全文 Run（冪等）
--
--  用途: 施設プロフィール画面のドロップダウンで施設タイプ(7区分)を設定し、
--        灯の層3コンテキストに注入 → 基準PL(施設タイプ別)で水準評価できるようにする。
--  値域: 小規模旅館/温泉旅館/小規模都市型ホテル/中規模旅館/都市型ホテル/高級旅館/大規模旅館
--        （standard_pl_master.facility_type と一致させる）
-- ============================================================

alter table dim_facility_profile add column if not exists facility_type text;

-- FRY（フォレストリゾート山の手ホテル）= 温泉旅館（他施設は追ってプロフィール画面で設定）
insert into dim_facility_profile (facility, facility_type)
values ('FRY', '温泉旅館')
on conflict (facility) do update set facility_type = excluded.facility_type;

-- 確認: select facility, facility_type from dim_facility_profile order by facility;
-- ロールバック: alter table dim_facility_profile drop column if exists facility_type;
