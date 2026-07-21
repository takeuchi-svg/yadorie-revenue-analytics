-- ============================================================
--  従業員の並び順（各宿設定で編集・シフト表の行順に反映）／冪等
--  Supabase SQL Editor で Run。
-- ============================================================
alter table dim_staff
  add column if not exists sort_order int not null default 0;

-- 既存従業員に初期の並び順を付与（未設定=0 の宿は staff_code 順で 10,20,30…）
with ranked as (
  select staff_code,
         row_number() over (partition by home_facility order by staff_code) * 10 as so
  from dim_staff
  where coalesce(sort_order, 0) = 0
)
update dim_staff d set sort_order = r.so
from ranked r where r.staff_code = d.staff_code and coalesce(d.sort_order, 0) = 0;

-- 確認: select home_facility, name, sort_order from dim_staff order by home_facility, sort_order;
