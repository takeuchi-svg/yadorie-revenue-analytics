-- ============================================================
--  全社Core: 開業日/取得日 の実データ投入（seed）
--  前提: company_opening_date.sql を先に実行（opening_date カラム追加済み）
--  Supabase SQL Editor で全文 Run（冪等・再実行で上書き）
--
--  施設名→BIコードは src/lib/etl/attendance-parser.ts の NAME_FAC 対応表に準拠。
--  日付は「月」まで判明分を月初(01日)で格納（日は区分判定に不使用）。
-- ============================================================

update dim_facility f set opening_date = v.d
from (values
  -- 施設名（ユーザー提供）   BIコード   開業/取得月
  ('MRM'::text, date '2026-04-01'),  -- 森本
  ('KMY',       date '2026-04-01'),  -- かめや
  ('AOY',       date '2026-04-01'),  -- 小谷の湯
  ('HGY',       date '2025-02-01'),  -- 東屋
  ('NIE',       date '2025-02-01'),  -- NOIE
  ('HRM',       date '2025-03-01'),  -- はりも（マリーンホテルはりも）
  ('FRY',       date '2024-11-01'),  -- 山の手（フォレストリゾート山の手ホテル）
  ('BSN',       date '2024-06-01'),  -- Baison
  ('YNT',       date '2024-06-01'),  -- 湯の季
  ('KR',        date '2023-11-01'),  -- かたくり（かたくりの花）
  ('SR',        date '2023-11-01'),  -- しらはま
  ('SY',        date '2023-07-01'),  -- 笹屋
  ('YZ',        date '2023-04-01'),  -- ゆずり葉
  ('ON',        date '2022-09-01'),  -- Onn中津川
  ('OY',        date '2022-08-01'),  -- Onn湯田温泉
  ('TR',        date '2021-06-01'),  -- つるや旅館
  ('IK',        date '2021-04-01'),  -- 一久旅館
  ('MI',        date '2021-04-01'),  -- 伊豆高原温泉ホテル森の泉
  ('AP',        date '2020-09-01'),  -- 安比高原森のホテル
  ('KT',        date '2019-10-01'),  -- 海遊亭
  ('OOH',       date '2025-04-01'),  -- Onn大曲の花火
  ('KJK',       date '2025-04-01'),  -- かじか
  ('OQ',        date '2019-09-01'),  -- OQOQ
  ('TK',        date '2019-09-01'),  -- 玉井館
  ('MH',        date '2019-07-01'),  -- 木曽駒高原森のホテル
  ('GZ',        date '2018-04-01'),  -- 旅館岐山
  ('NS',        date '2018-04-01')   -- 旅館ぬしや
) as v(facility, d)
where f.facility = v.facility;

-- 全27施設 opening_date 投入済み（NULL残りなし）。

-- 確認: select facility, name, opening_date from dim_facility order by opening_date nulls last, facility;
