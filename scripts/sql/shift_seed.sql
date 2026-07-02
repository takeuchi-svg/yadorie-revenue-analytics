-- ============================================================
--  シフト・労務管理 v1  マスタ初期データ（T02）※冪等
--  役割7件 / 勤務パターン4件（休日2件は shift_setup.sql で投入済）
--  設定画面で後から編集可。
-- ============================================================

-- 役割 7件
insert into dim_role (role_name, sort_order)
select v.role_name, v.sort_order from (values
    ('フロント',10),('客室清掃',20),('朝食',30),
    ('パントリー',40),('夜警',50),('バス',60),('施設管理',70)
  ) as v(role_name, sort_order)
where not exists (select 1 from dim_role d where d.role_name = v.role_name);

-- 勤務パターン 4件（ナイトは日跨ぎ: work_minutes=(end+24h)-start-break で扱う）
insert into dim_shift_pattern (pattern_type,name,start_time,end_time,break_minutes,color,sort_order)
select v.* from (values
    ('勤務','早番',   time '07:00', time '16:00', 60, '#378ADD', 10),
    ('勤務','中番',   time '12:00', time '21:00', 60, '#639922', 20),
    ('勤務','遅番',   time '12:30', time '21:30', 60, '#BA7517', 30),
    ('勤務','ナイト', time '16:00', time '10:00', 120,'#7F77DD', 40)
  ) as v(pattern_type,name,start_time,end_time,break_minutes,color,sort_order)
where not exists (
  select 1 from dim_shift_pattern d where d.pattern_type='勤務' and d.name = v.name
);
