-- ============================================================
--  RLS 是正パッチ（棚卸レビュー2026-07-22）／冪等・SQL Editorで Run
--  背景: 外部レビューで下記2点が判明。ライブDB即時適用の“今すぐ版”。
--   ② dim_labor_rate / raw_regular_labor_monthly が using(true) ＝
--      ログインさえしていれば全宿の人件費（宿別標準時給・正社員 宿×月）を読めた。
--      → 他の施設スコープ表と同じ can_access_facility に統一（担当宿のみ）。
--   ③ 施設コード(text)の参照整合が未強制 → user_facility 等に FK を張り、
--      存在しない施設コードの割当（不可視の孤児行の温床）を物理的に防ぐ。
--  ※ labor_model_v2.sql 本体も同じ内容に修正済（このファイルは既存DBへの即時適用用）。
-- ============================================================

-- ---- ② 人件費まわり2表を施設スコープへ是正 ----
do $$
declare t text; pol record;
begin
  foreach t in array array['dim_labor_rate','raw_regular_labor_monthly']
  loop
    if to_regclass('public.'||t) is null then continue; end if;
    execute format('alter table %I enable row level security', t);
    for pol in select policyname from pg_policies where schemaname='public' and tablename=t loop
      execute format('drop policy %I on %I', pol.policyname, t);
    end loop;
    execute format(
      'create policy %I on %I for all to authenticated using (public.can_access_facility(facility)) with check (public.can_access_facility(facility))',
      t||'_facility_scope', t);
  end loop;
end $$;

-- ---- ③ 施設コードの参照整合（FK）。empty のうちに張る。既存FKは飛ばす ----
--   まず孤児が無いことを確認してから張る（あると ALTER が失敗するので事前検知）。
do $$
declare
  spec text[][] := array[
    ['user_facility','facility'],
    ['dim_labor_rate','facility'],
    ['raw_regular_labor_monthly','facility']
  ];
  rec text[]; orphan int; cname text;
begin
  foreach rec slice 1 in array spec loop
    if to_regclass('public.'||rec[1]) is null then continue; end if;
    -- 孤児（dim_facility に無い施設コード）が無いか確認
    execute format(
      'select count(*) from %I x where x.%I is not null and not exists (select 1 from dim_facility f where f.facility = x.%I)',
      rec[1], rec[2], rec[2]) into orphan;
    if orphan > 0 then
      raise notice '% : 孤児施設コード % 件 → FK未付与（先にデータ是正が必要）', rec[1], orphan;
      continue;
    end if;
    cname := rec[1]||'_'||rec[2]||'_fk';
    if not exists (select 1 from pg_constraint c where c.conname = cname) then
      execute format(
        'alter table %I add constraint %I foreign key (%I) references dim_facility(facility) on update cascade',
        rec[1], cname, rec[2]);
      raise notice '% : FK 付与', rec[1];
    end if;
  end loop;
end $$;

-- ---- ②-b budget_daily / budget_monthly / budget_lock を施設スコープへ是正 ----
--   rls_audit で判明: budget_lock.sql の using(true) が live で勝っており、
--   認証者が全宿の予算を読み書きできた（ロック検査はあるが施設スコープが無かった）。
--   施設スコープ＋ロック検査を1本に統合（budget_lock.sql 本体も同内容に修正済）。
drop policy if exists budget_lock_read on budget_lock;
create policy budget_lock_read on budget_lock for select to authenticated
  using (public.can_access_facility(facility));

drop policy if exists budget_daily_rw on budget_daily;
create policy budget_daily_rw on budget_daily for all to authenticated
  using (public.can_access_facility(facility))
  with check (public.can_access_facility(facility)
    and (budget_daily.version = '見込' or not exists (select 1 from budget_lock l where l.facility = budget_daily.facility and l.fiscal_year = budget_daily.fiscal_year)));

drop policy if exists budget_monthly_rw on budget_monthly;
create policy budget_monthly_rw on budget_monthly for all to authenticated
  using (public.can_access_facility(facility))
  with check (public.can_access_facility(facility)
    and (budget_monthly.version = '見込' or not exists (select 1 from budget_lock l where l.facility = budget_monthly.facility and l.fiscal_year = budget_monthly.fiscal_year)));

-- 確認:
--   select tablename, policyname, cmd, qual from pg_policies
--     where tablename in ('dim_labor_rate','raw_regular_labor_monthly','budget_daily','budget_monthly','budget_lock');
--   select conname, conrelid::regclass from pg_constraint where conname like '%_facility_fk';
--   -- 仕上げに rls_audit.sql を Run して 0行（B/C とも）を確認。
