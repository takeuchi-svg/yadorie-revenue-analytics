-- ============================================================
--  予算ロック（鍵締め）: 確定した予算を上書きできないようにする
--  Supabase SQL Editor で全文 Run（冪等）
--
--  - budget_lock(facility, fiscal_year) に行があれば = その宿×年度はロック（確定）。
--  - 施錠/解錠は owner のみ（budget_lock への書込みポリシー）。閲覧は全員。
--  - ロック中は budget_daily / budget_monthly への INSERT/UPDATE を拒否（owner含め不可。編集は解錠してから）。
--    ※ service_role(import/upload スクリプト)は RLS を迂回するため過年度の再取込は可能。
--  - 初期ロック: 2026年度以前を全宿ロック（Coreでの予算作成は2027年度から）。
-- ============================================================

create table if not exists budget_lock (
  facility    TEXT not null references dim_facility(facility),
  fiscal_year TEXT not null,
  locked_by   TEXT,
  locked_at   TIMESTAMPTZ default now(),
  primary key (facility, fiscal_year)
);
alter table budget_lock enable row level security;
drop policy if exists budget_lock_read on budget_lock;
create policy budget_lock_read on budget_lock for select to authenticated using (true);
drop policy if exists budget_lock_write on budget_lock;
create policy budget_lock_write on budget_lock for all to authenticated
  using (public.my_role() = 'owner') with check (public.my_role() = 'owner');

-- 予算テーブル: ロック中の(facility,fiscal_year)への書込みを禁止（WITH CHECK）。読み取り・削除はUSINGで従来通り。
drop policy if exists "allow_all_authenticated" on budget_daily;
drop policy if exists budget_daily_rw on budget_daily;
create policy budget_daily_rw on budget_daily for all to authenticated
  using (true)
  with check (not exists (select 1 from budget_lock l where l.facility = budget_daily.facility and l.fiscal_year = budget_daily.fiscal_year));

drop policy if exists "allow_all_authenticated" on budget_monthly;
drop policy if exists budget_monthly_rw on budget_monthly;
create policy budget_monthly_rw on budget_monthly for all to authenticated
  using (true)
  with check (not exists (select 1 from budget_lock l where l.facility = budget_monthly.facility and l.fiscal_year = budget_monthly.fiscal_year));

-- 初期ロック: 2020〜2026年度を全宿ロック（過年度・当年度の確定予算を保護）
insert into budget_lock (facility, fiscal_year, locked_by)
select f.facility, y.fy, 'seed(初期ロック)'
from dim_facility f
cross join (values ('2020'),('2021'),('2022'),('2023'),('2024'),('2025'),('2026')) as y(fy)
on conflict do nothing;

-- 確認: select fiscal_year, count(*) from budget_lock group by fiscal_year order by fiscal_year;
-- 解錠(owner・SQLでやる場合): delete from budget_lock where facility='XXX' and fiscal_year='2026';
