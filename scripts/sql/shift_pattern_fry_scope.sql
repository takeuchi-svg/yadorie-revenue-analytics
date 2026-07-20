-- ============================================================
--  シフトパターンの所属整理  Supabase SQL Editor で Run（冪等）
--  早番/中番/遅番/ナイト は山の手ホテル(FRY)固有パターンにする（他の宿には出さない）。
--  全社共通(facility IS NULL)として残すのは 公休・有給 のみ。
--  ※ pattern_id は不変なので、FRYの既存シフト(raw_shift_plan)はそのまま。
-- ============================================================

update dim_shift_pattern
   set facility = 'FRY'
 where facility is null
   and name in ('早番', '中番', '遅番', 'ナイト');

-- 確認: select pattern_id, name, facility from dim_shift_pattern order by sort_order;
