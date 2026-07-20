-- ============================================================
--  予算作成: 修繕投資計画 ＋ 人員計画  Supabase SQL Editor で全文 Run（冪等）
--  参照元スプレッドシート = HRM_2026予実管理.xlsx の「②修繕投資計画」「④人員計画」
--  方針: ①PL計上/BS計上は記録のみ(自動でPL・減価償却に反映しない) ②人員は人数＋自由記述のみ
--        ③予算ロック(budget_lock)とは非連動(計画は随時更新可)。RLSは施設スコープ。
-- ============================================================

-- ---- ② 修繕投資計画（1行1案件・年度ごと） ----
create table if not exists raw_capex_plan (
  id           BIGSERIAL primary key,
  facility     TEXT not null references dim_facility(facility),
  fiscal_year  TEXT not null,               -- '2026' 等
  seq          INTEGER,                       -- 番号(表示順)
  priority     TEXT,                          -- 高 / 中 / 低
  kind         TEXT,                          -- 修繕 / 投資
  pl_booked    BOOLEAN default false,         -- PL計上（記録のみ）
  bs_booked    BOOLEAN default false,         -- BS計上（記録のみ・資産性）
  order_ym     TEXT,                          -- 発注予定年月 'YYYY-MM'
  place        TEXT,                          -- 場所
  content      TEXT,                          -- 内容
  qty          NUMERIC default 1,             -- 数量
  unit_price   BIGINT default 0,              -- 単価(円)
  amount       BIGINT default 0,              -- 総額(円)= 数量×単価（保存時に計算）
  vendor       TEXT,                          -- 取引先
  payment      TEXT,                          -- 支払い
  done         BOOLEAN default false,         -- 実施済
  memo         TEXT,
  updated_by   TEXT,
  updated_at   TIMESTAMPTZ default now()
);
create index if not exists idx_capex_fac_fy on raw_capex_plan(facility, fiscal_year, seq);

-- ---- ④ 人員計画（月別の人数。職種内訳つき） ----
create table if not exists raw_staffing_plan (
  facility     TEXT not null references dim_facility(facility),
  fiscal_year  TEXT not null,               -- '2026'
  month        TEXT not null,               -- 'YYYY-MM'
  fulltime     INTEGER,                      -- 正社員数（採用含む）
  parttime     INTEGER,                      -- アルバイト数
  dispatch     INTEGER,                      -- 派遣（繁忙期派遣・調理場助など）
  svc          INTEGER,                      -- 内訳: サービス
  clean        INTEGER,                      -- 内訳: 清掃
  cook         INTEGER,                      -- 内訳: 調理
  night        INTEGER,                      -- 内訳: 夜警
  updated_by   TEXT,
  updated_at   TIMESTAMPTZ default now(),
  primary key (facility, fiscal_year, month)
);

-- ---- ④ 人員計画 自由記述（年度ごと・外注/育成/特記） ----
create table if not exists raw_staffing_note (
  facility     TEXT not null references dim_facility(facility),
  fiscal_year  TEXT not null,
  outsourcing  TEXT,                          -- 外注（外部委託）
  development  TEXT,                          -- 人材育成・配置転換・業務改善
  remarks      TEXT,                          -- 特記事項
  updated_by   TEXT,
  updated_at   TIMESTAMPTZ default now(),
  primary key (facility, fiscal_year)
);

-- ---- RLS（施設スコープ。rls_facility.sql と同方式） ----
do $$
declare t text; pol record;
begin
  foreach t in array array['raw_capex_plan','raw_staffing_plan','raw_staffing_note'] loop
    execute format('alter table %I enable row level security', t);
    for pol in select policyname from pg_policies where schemaname='public' and tablename=t loop
      execute format('drop policy %I on %I', pol.policyname, t);
    end loop;
    execute format(
      'create policy %I on %I for all to authenticated using (public.can_access_facility(facility)) with check (public.can_access_facility(facility))',
      t || '_facility_scope', t);
  end loop;
end $$;

-- 確認: select facility, fiscal_year, count(*) from raw_capex_plan group by 1,2;
