-- ============================================================
--  mart マテリアライズ化（フェーズ2・スケール準備）  Supabase SQL Editor で実行
--
--  目的: 施設数×年数が増えると mart_ ビュー（毎回rawをフル集計）が遅くなる。
--        重いビューをマテリアライズドビュー（結果を保存）に置き換えて高速化する。
--
--  【重要】マテリアライズドビューは RLS を持てない（全行が見える）。
--        施設スコープを守るため必ず「matview(全データ) ＋ 施設ゲート付きの通常view」
--        の2段構成にする（下のテンプレの通り）。
--
--  【いつやるか】1施設のうちは不要。ページ表示が体感で遅くなったら、遅いビューだけ
--        テンプレに沿って個別に変換する（全17ビューを一括変換する必要はない）。
--
--  取込後の更新: アップロード完了時にアプリが public.refresh_all_marts() を呼ぶ（配線済）。
--        本ファイルを未適用でもアプリは無害にスキップする。
-- ============================================================

-- ---- 全マテビューを一括REFRESHする関数（存在するmatviewを自動で回す） ----
create or replace function public.refresh_all_marts() returns void
language plpgsql security definer set search_path = public as $$
declare r record;
begin
  for r in select matviewname from pg_matviews where schemaname = 'public' loop
    begin
      execute format('refresh materialized view concurrently %I', r.matviewname);  -- 無停止（要: 一意index）
    exception when others then
      execute format('refresh materialized view %I', r.matviewname);               -- フォールバック
    end;
  end loop;
end $$;
grant execute on function public.refresh_all_marts() to authenticated;

-- ============================================================
--  変換テンプレ（1ビューずつ・コメントアウト。遅くなったビューに適用する）
--  例: mart_meal_monthly（basic_product × reservation のJOIN集計＝重い候補）
-- ============================================================
/*
-- 1) 既存の通常ビューを退避して落とす
drop view if exists mart_meal_monthly;

-- 2) 全データのマテビュー（施設フィルタなし。authenticated には直接見せない）
--    ★中身は元の mart_meal_monthly の SELECT 定義をそのまま貼る（migrate.mjs 参照）
create materialized view mart_meal_monthly_mat as
  <元のSELECT定義をここに>;
-- CONCURRENTLY refresh 用の一意index（粒度キーで一意になるように）
create unique index on mart_meal_monthly_mat (facility, month, meal_type);
revoke all on mart_meal_monthly_mat from authenticated, anon;

-- 3) 施設ゲート付きの通常ビュー（呼び出し名は元のまま）。security_invoker=off＋WHEREで絞る
create view mart_meal_monthly as
  select * from mart_meal_monthly_mat
  where public.is_admin()
     or facility in (select facility from user_facility where user_id = auth.uid());
alter view mart_meal_monthly set (security_invoker = off);
grant select on mart_meal_monthly to authenticated;

-- 4) 初回更新
refresh materialized view mart_meal_monthly_mat;
*/

-- ============================================================
--  適用後の確認
--    select matviewname from pg_matviews where schemaname='public';
--    select public.refresh_all_marts();
-- ============================================================
