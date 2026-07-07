-- ============================================================
--  AIナレッジ基盤 第1弾 K30（Phase 2）── 給与守秘・機密区分
--  Supabase SQL Editor で全文 Run（冪等）
--
--  ★★ 実行前に1箇所だけ編集 ★★
--    下の CHANGE_ME_STRONG_PASSWORD を強いパスワードに置き換えてから Run。
--    （英数字記号20文字以上推奨。このパスワードは Vercel の AI_DB_URL に使います）
--
--  内容:
--   [1] AI専用DBロール ai_reader（LOGIN・mart_ai スキーマのみ読める＝物理防御）
--   [2] ai_config（k-匿名しきい値などの設定値）
--   [3] mart_ai スキーマ再構築（AIが読んでよいビューのみ。個人給与系は存在しない）
--       - actual_monthly / budget_monthly: 在籍人数がしきい値未満の施設は人件費科目の金額をNULL化（k-匿名）
--       - dim_productivity_manual: 同様に みなし残業超残業代 をNULL化
--       - labor_cost_ratio_monthly: 率のみの人件費率ビュー（小規模宿でも安全に比較可能）
--   [4] data_confidentiality に機密区分 C0〜C3 を投入（C0の説明文から許可リストを自動生成）
--
--  ロールバック: drop schema mart_ai cascade; drop role ai_reader;（既存機能に影響なし）
-- ============================================================

-- ---- [1] AI専用ロール（publicスキーマへの権限は一切持たない） ----
do $$
begin
  if not exists (select from pg_roles where rolname = 'ai_reader') then
    execute format('create role ai_reader login password %L', 'CHANGE_ME_STRONG_PASSWORD');
  end if;
end $$;
alter role ai_reader set statement_timeout = '15s';
-- 念のため public 側の権限を明示的に剥奪（既定でも付与されていないが宣言しておく）
revoke all on all tables in schema public from ai_reader;
revoke all on all functions in schema public from ai_reader;
revoke usage on schema public from ai_reader;

-- ---- [2] 設定値（k-匿名しきい値。初期5名） ----
create table if not exists ai_config (
  key TEXT primary key,
  value TEXT not null,
  note TEXT,
  updated_by TEXT, updated_at TIMESTAMPTZ default now()
);
insert into ai_config (key, value, note) values
  ('k_anon_min_staff', '5', '在籍人数がこの値未満の施設は、人件費の絶対額をAIに渡さない（率のみ）')
on conflict (key) do nothing;
alter table ai_config enable row level security;
do $$
declare pol record;
begin
  for pol in select policyname from pg_policies where schemaname='public' and tablename='ai_config' loop
    execute format('drop policy %I on ai_config', pol.policyname);
  end loop;
end $$;
create policy ai_config_view on ai_config for select to authenticated
  using (public.role_rank(public.my_role()) >= public.role_rank('admin'));

-- ---- [3] mart_ai スキーマ（毎回作り直し＝冪等。中身はビューのみでデータは持たない） ----
drop schema if exists mart_ai cascade;
create schema mart_ai;

-- そのまま公開してよいビュー/テーブル（個人給与とは無関係）
create view mart_ai.mart_monthly_kpi          as select * from public.mart_monthly_kpi;
create view mart_ai.mart_occupancy_monthly    as select * from public.mart_occupancy_monthly;
create view mart_ai.mart_occupancy_daily      as select * from public.mart_occupancy_daily;
create view mart_ai.mart_channel_monthly      as select * from public.mart_channel_monthly;
create view mart_ai.mart_room_monthly         as select * from public.mart_room_monthly;
create view mart_ai.mart_room_type_monthly    as select * from public.mart_room_type_monthly;
create view mart_ai.mart_meal_monthly         as select * from public.mart_meal_monthly;
create view mart_ai.mart_residence_monthly    as select * from public.mart_residence_monthly;
create view mart_ai.mart_plan_monthly         as select * from public.mart_plan_monthly;
create view mart_ai.mart_adr_band_monthly     as select * from public.mart_adr_band_monthly;
create view mart_ai.mart_gs_monthly           as select * from public.mart_gs_monthly;
create view mart_ai.mart_cxl_summary          as select * from public.mart_cxl_summary;
create view mart_ai.mart_cxl_lt               as select * from public.mart_cxl_lt;
create view mart_ai.mart_booking_lt           as select * from public.mart_booking_lt;
create view mart_ai.mart_budget_revenue_monthly as select * from public.mart_budget_revenue_monthly;
create view mart_ai.mart_onhand_monthly       as select * from public.mart_onhand_monthly;
create view mart_ai.mart_budget_daily_monthly as select * from public.mart_budget_daily_monthly;
create view mart_ai.mart_labor_monthly        as select * from public.mart_labor_monthly;  -- 時間・人数のみ（金額なし）
create view mart_ai.dim_facility              as select facility, name, short_name, total_rooms from public.dim_facility;
create view mart_ai.raw_other_product         as select facility, item_name, category, unit_price, quantity, total, source_month, status from public.raw_other_product;
create view mart_ai.raw_room_sales            as select facility, stay_date, scope, room_type, sold, source_month from public.raw_room_sales;

-- k-匿名: 人件費科目コード（このリストの科目は小規模施設で金額NULL化）
--   在籍人数 = dim_staff の home_facility 別・スポット除く人数（不明=0 として安全側に倒す）
create view mart_ai.actual_monthly as
select
  a.facility, a.fiscal_year, a.month, a.category, a.item_code, a.item_name,
  case when a.item_code in ('給料手当','賞与','通勤費','法定福利費','福利厚生費','雑給','labor_total',
                            '外注費','外注費_人材_','外注費_清掃_','外注費_その他_','業務委託料')
        and coalesce(sc.n, 0) < th.v
       then null else a.actual end as actual,
  case when a.item_code in ('給料手当','賞与','通勤費','法定福利費','福利厚生費','雑給','labor_total',
                            '外注費','外注費_人材_','外注費_清掃_','外注費_その他_','業務委託料')
        and coalesce(sc.n, 0) < th.v
       then null else a.prior_amount end as prior_amount
from public.actual_monthly a
left join lateral (
  select count(*) as n from public.dim_staff s
  where s.home_facility = a.facility and coalesce(s.is_spot, false) = false
) sc on true
cross join lateral (
  select coalesce((select value::int from public.ai_config where key = 'k_anon_min_staff'), 5) as v
) th;

create view mart_ai.budget_monthly as
select
  b.facility, b.fiscal_year, b.month, b.category, b.item_code, b.item_name,
  case when b.item_code in ('給料手当','賞与','通勤費','法定福利費','福利厚生費','雑給','labor_total',
                            '外注費','外注費_人材_','外注費_清掃_','外注費_その他_','業務委託料')
        and coalesce(sc.n, 0) < th.v
       then null else b.amount end as amount,
  b.ratio, b.sort_order
from public.budget_monthly b
left join lateral (
  select count(*) as n from public.dim_staff s
  where s.home_facility = b.facility and coalesce(s.is_spot, false) = false
) sc on true
cross join lateral (
  select coalesce((select value::int from public.ai_config where key = 'k_anon_min_staff'), 5) as v
) th;

create view mart_ai.dim_productivity_manual as
select
  d.facility, d.month,
  case when coalesce(sc.n, 0) < th.v then null else d.deemed_overtime_excess_pay end as deemed_overtime_excess_pay,
  d.dispatch_work_hours, d.dispatch_other_notes
from public.dim_productivity_manual d
left join lateral (
  select count(*) as n from public.dim_staff s
  where s.home_facility = d.facility and coalesce(s.is_spot, false) = false
) sc on true
cross join lateral (
  select coalesce((select value::int from public.ai_config where key = 'k_anon_min_staff'), 5) as v
) th;

-- 率のみの人件費率（k-匿名の影響を受けず、小規模宿でも安全に横断比較できる）
create view mart_ai.labor_cost_ratio_monthly as
with pl as (
  select facility, month,
    sum(actual) filter (where item_code in ('給料手当','賞与','通勤費','法定福利費','福利厚生費','雑給',
                                            '外注費','外注費_人材_','外注費_清掃_','外注費_その他_','業務委託料')) as labor_cost,
    max(actual) filter (where item_code = 'sales_total') as sales
  from public.actual_monthly
  group by facility, month
)
select facility, month,
  case when sales > 0 and labor_cost is not null then round(labor_cost / sales, 4) end as labor_cost_ratio
from pl;

-- ai_reader へ mart_ai のみ許可
grant usage on schema mart_ai to ai_reader;
grant select on all tables in schema mart_ai to ai_reader;
alter default privileges in schema mart_ai grant select on tables to ai_reader;
-- 人間のロール（authenticated等）には mart_ai を公開しない（AIの専用窓口）

-- ---- [4] 機密区分 C0〜C3 の投入 ----
--   C0=AI可（ai_description が許可リストに自動掲載） / C1=施設メンバー可・AI不可
--   C2=権限者のみ・AI不可 / C3=個人給与級・AI絶対不可
alter table data_confidentiality add column if not exists sort_order INT not null default 100;

insert into data_confidentiality (object_name, column_name, level, sort_order, ai_description, note) values
  ('mart_monthly_kpi', null, 'C0', 10, $d$mart_monthly_kpi(facility, month 'YYYY-MM', revenue 売上, rooms_sold 室泊数, guests 人泊数, adr 室単価(1室1泊), guest_unit 客単価(人泊単価=1人1泊), companion 同伴係数(人泊÷室泊)) ※チェックイン月に計上(freee計上基準)。稼働率はmart_occupancy_monthlyを使うこと$d$, null),
  ('mart_occupancy_monthly', null, 'C0', 20, $d$mart_occupancy_monthly(facility, month, rooms_sold 販売室数, operating_days, total_rooms, occ) ※稼働率の正データ(販売数集計表由来)$d$, null),
  ('mart_occupancy_daily', null, 'C0', 30, $d$mart_occupancy_daily(facility, date 'YYYY-MM-DD', rooms_sold, total_rooms, occ)$d$, null),
  ('mart_channel_monthly', null, 'C0', 40, $d$mart_channel_monthly(facility, month, channel チャネル, revenue, rooms, guests, adr, guest_unit)$d$, null),
  ('mart_room_type_monthly', null, 'C0', 50, $d$mart_room_type_monthly(facility, month, room_type 部屋タイプ, revenue, rooms_sold, guests, adr)$d$, null),
  ('mart_room_monthly', null, 'C0', 55, $d$mart_room_monthly(facility, month, room 客室, revenue, rooms_sold, guests, adr, companion)$d$, null),
  ('mart_meal_monthly', null, 'C0', 60, $d$mart_meal_monthly(facility, month, meal_type 喫食(2食付/朝食付/素泊り等), reservations 予約数, revenue, rooms, guests)$d$, null),
  ('mart_residence_monthly', null, 'C0', 70, $d$mart_residence_monthly(facility, month, prefecture 都道府県/国, region, bookings, guests, revenue, guest_unit)$d$, null),
  ('mart_plan_monthly', null, 'C0', 80, $d$mart_plan_monthly(facility, month, plan, bookings, revenue, rooms_total 室泊, guests 人泊, adr) ※ステイシーC/O確定=freee計上基準$d$, null),
  ('mart_adr_band_monthly', null, 'C0', 90, $d$mart_adr_band_monthly(facility, month, band ADR帯(1室1泊), bookings, revenue, rooms_total, adr) ※ステイシーC/O確定$d$, null),
  ('mart_gs_monthly', null, 'C0', 100, $d$mart_gs_monthly(facility, month, group_size, bookings, revenue, rooms_total, adr) ※ステイシーC/O確定$d$, null),
  ('mart_cxl_summary', null, 'C0', 110, $d$mart_cxl_summary(facility, month, channel, bookings 全予約(取消含む), cancels 取消, cancel_revenue, cxl_rate 取消率=取消÷全予約) ※ステイシー全チャネル(直予約/電話/エージェント含む)$d$, null),
  ('mart_cxl_lt', null, 'C0', 120, $d$mart_cxl_lt(facility, month, bucket リードタイム帯, count) ※取消の予約日→CIまでの日数分布$d$, null),
  ('mart_booking_lt', null, 'C0', 130, $d$mart_booking_lt(facility, month, bucket, revenue, rooms_total, guests, adr, count) ※ステイシーC/O確定・予約日基準のLT別売上$d$, null),
  ('budget_monthly', null, 'C0', 140, $d$budget_monthly(facility, fiscal_year '2025'/'2026', month, category, item_code, item_name, amount) ※予算P&L。item_code='sales_total'が売上予算, 'operating_income'が営業損益, 'cogs_total'原価, 'sga_total'販管費。小規模施設は人件費科目がnull(守秘)$d$, null),
  ('actual_monthly', null, 'C0', 150, $d$actual_monthly(facility, fiscal_year, month, item_code, item_name, actual 実績, prior_amount 昨年) ※小規模施設は人件費科目がnull(守秘)。人件費率はlabor_cost_ratio_monthlyで参照可$d$, null),
  ('mart_budget_revenue_monthly', null, 'C0', 160, $d$mart_budget_revenue_monthly(facility, month, revenue_budget)$d$, null),
  ('mart_onhand_monthly', null, 'C0', 170, $d$mart_onhand_monthly(facility, month, room_nights オンハンド室泊, room_nights_stayed 宿泊済(C/O), room_nights_confirmed 確定, room_nights_tentative 未確認, guest_nights 人泊, revenue, adr) ※現時点の予約の入り具合(キャンセル除く)。将来月＝ブッキングペース。最新スナップショット$d$, null),
  ('mart_budget_daily_monthly', null, 'C0', 180, $d$mart_budget_daily_monthly(facility, month, rooms_budget 予算室泊, revenue_budget 予算売上, inventory_budget 予算在庫) ※日次予算の月ロールアップ。オンハンドの比較相手$d$, null),
  ('raw_other_product', null, 'C0', 190, $d$raw_other_product(facility, item_name 商品, category, total, quantity, source_month) ※料飲/物販の明細(売れ筋)$d$, null),
  ('dim_facility', null, 'C0', 200, $d$dim_facility(facility, name, total_rooms)$d$, null),
  ('raw_room_sales', null, 'C0', 205, $d$raw_room_sales(facility, stay_date, scope 'total'/'type', room_type, sold 販売室数, source_month) ※販売数集計表の生データ$d$, null),
  ('mart_labor_monthly', null, 'C0', 210, $d$mart_labor_monthly(facility, month, staff_count_monthly 月給社員数, parttime_count アルバイト数, total_work_hours 総労働時間, total_overtime_hours 総残業時間, own_work_hours 自施設, help_work_hours ヘルプ, operating_days) ※勤怠由来・時間と人数のみ(金額なし)。本社(HQ)は除外済み。未取込の月は行が無い$d$, null),
  ('dim_productivity_manual', null, 'C0', 220, $d$dim_productivity_manual(facility, month, deemed_overtime_excess_pay みなし残業超の残業代(円・小規模施設はnull), dispatch_work_hours 派遣・その他の労働時間(h)) ※手動入力$d$, null),
  ('labor_cost_ratio_monthly', null, 'C0', 230, $d$labor_cost_ratio_monthly(facility, month, labor_cost_ratio 売上高人件費率0-1) ※率のみのため全施設で参照可(守秘対応済み)。施設横断の人件費比較はこれを使う$d$, null),
  -- AI不可（C1〜C3。ドキュメント目的＝なぜ許可リストに無いかの台帳）
  ('mart_labor_cost_monthly', null, 'C1', 900, null, '施設×月の人件費合計。人はUI(生産性)で閲覧可・AIはlabor_cost_ratio_monthly(率)のみ'),
  ('raw_attendance_daily', null, 'C1', 905, null, '個人別の勤怠明細。AI不可(個人の労働時間はプライバシー)'),
  ('dim_staff', null, 'C2', 910, null, '従業員マスタ(氏名)。AI不可'),
  ('app_user', null, 'C2', 920, null, 'アカウント情報。AI不可'),
  ('user_facility', null, 'C2', 921, null, '施設割当。AI不可'),
  ('ai_prompt', null, 'C2', 930, null, 'プロンプト正本。owner専用'),
  ('ai_knowledge', null, 'C2', 931, null, 'AIナレッジ。役割に応じ閲覧'),
  ('dim_staff_wage', null, 'C3', 990, null, '個人別賃金。AI絶対不可・給与権限者のみ'),
  ('mart_labor_cost_actual', null, 'C3', 991, null, '個人別人件費(実績)。AI絶対不可・給与権限者のみ'),
  ('mart_labor_cost_plan', null, 'C3', 992, null, '個人別人件費(計画)。AI絶対不可・給与権限者のみ')
on conflict (object_name, column_name) do update
  set level = excluded.level, sort_order = excluded.sort_order,
      ai_description = excluded.ai_description, note = excluded.note;

-- ---- 動作確認（Runした後にこの3つを個別に実行して結果を教えてください） ----
-- 1) ai_reader は mart_ai だけ読める（true / false / false になればOK）
-- select has_schema_privilege('ai_reader','mart_ai','usage')   as mart_ai_ok,
--        has_schema_privilege('ai_reader','public','usage')    as public_ng,
--        has_table_privilege('ai_reader','public.dim_staff_wage','select') as wage_ng;
-- 2) mart_ai のビュー一覧
-- select table_name from information_schema.views where table_schema='mart_ai' order by table_name;
-- 3) k-匿名の効き（FRYは27名なので数値が出る。人数不明の施設はnullになる）
-- select facility, item_code, actual from mart_ai.actual_monthly where item_code='給料手当' order by facility, month desc limit 10;
