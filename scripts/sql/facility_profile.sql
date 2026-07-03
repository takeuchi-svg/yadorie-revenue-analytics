-- ============================================================
--  施設プロフィール（AIコンテキスト基盤）F1  Supabase SQL Editor で実行（冪等）
--  正本: docs/要件定義書_施設プロフィール_AIコンテキスト.md
--  読み替え: RLSは既存標準の施設スコープを最初から適用
--  （admin=全施設 / member=割当施設のみ ＝ 要件のR1共同編集とR2自走を同時に満たす）
-- ============================================================

-- ---- 1) 施設プロフィール（静的・上書き） ----
create table if not exists dim_facility_profile (
  facility TEXT primary key references dim_facility(facility),
  -- 基本情報（事実・静的）
  location_context TEXT,
  history TEXT,
  room_composition TEXT,
  onsen_spec TEXT,
  location_type TEXT,
  price_min INTEGER,
  price_max INTEGER,
  -- ブランド・コンセプト（意図）
  core_value TEXT,
  emotional_value TEXT,
  functional_value TEXT,
  brand_concept TEXT,
  target_experience TEXT,
  target_customer TEXT,
  differentiation TEXT,
  -- サービス・体験の実態
  services TEXT,
  dining_feature TEXT,
  room_feature TEXT,
  bath_feature TEXT,
  hospitality_policy TEXT,
  facility_amenity TEXT,
  -- 運営者の視点（意図）
  management_policy TEXT,
  ng_items TEXT,               -- ★必須（UI側で強調）
  seasonal_policy TEXT,
  competitors TEXT,            -- ★必須（UI側で強調）
  updated_at TIMESTAMPTZ default now(),
  updated_by TEXT
);

-- ---- 2) 繁閑理由（暦月1〜12・蓄積） ----
create table if not exists raw_seasonality_note (
  id BIGSERIAL primary key,
  facility TEXT not null references dim_facility(facility),
  month INTEGER not null check (month between 1 and 12),
  note TEXT,
  updated_at TIMESTAMPTZ default now(),
  unique (facility, month)
);

-- ---- 3) 取組履歴（時系列・蓄積。主観的成否カラムは持たない） ----
create table if not exists raw_facility_initiative (
  id BIGSERIAL primary key,
  facility TEXT not null references dim_facility(facility),
  year_month TEXT not null,     -- 'YYYY-MM'
  category TEXT,                -- 食事/接客/集客/設備/価格/オペレーション 等
  title TEXT not null,
  description TEXT,
  status TEXT default '実行',   -- 計画/実行/完了
  created_at TIMESTAMPTZ default now(),
  created_by TEXT
);
create index if not exists idx_initiative_fac_month on raw_facility_initiative(facility, year_month);

-- ---- RLS（既存標準: 施設スコープ） ----
do $$
declare t text; pol record;
begin
  foreach t in array array['dim_facility_profile','raw_seasonality_note','raw_facility_initiative'] loop
    execute format('alter table %I enable row level security', t);
    for pol in select policyname from pg_policies where schemaname='public' and tablename=t loop
      execute format('drop policy %I on %I', pol.policyname, t);
    end loop;
    execute format(
      'create policy %I on %I for all to authenticated using (public.can_access_facility(facility)) with check (public.can_access_facility(facility))',
      t || '_facility_scope', t);
  end loop;
end $$;
