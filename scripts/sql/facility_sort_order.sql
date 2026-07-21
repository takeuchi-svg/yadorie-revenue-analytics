-- ============================================================
--  全社ダッシュボードの宿の並び順（dim_facility.sort_order）／冪等
--  Supabase SQL Editor で Run。
-- ============================================================
alter table dim_facility add column if not exists sort_order int;

update dim_facility d set sort_order = v.so from (values
  ('NS', 10), ('GZ', 20), ('MH', 30), ('KT', 40), ('OQ', 50), ('TK', 60), ('AP', 70), ('MI', 80), ('IK', 90), ('TR', 100),
  ('OY', 110), ('ON', 120), ('YZ', 130), ('SY', 140), ('SR', 150), ('KR', 160), ('YNT', 170), ('BSN', 180), ('FRY', 190), ('HGY', 200),
  ('NIE', 210), ('HRM', 220), ('KJK', 230), ('OOH', 240), ('KMY', 250), ('AOY', 260), ('MRM', 270)
) as v(facility, so)
where d.facility = v.facility;

-- 確認: select facility, name, sort_order from dim_facility order by sort_order nulls last;
