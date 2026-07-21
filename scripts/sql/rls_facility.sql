-- ============================================================
--  RLS 施設スコープ化（フェーズ0-③）  Supabase SQL Editor で実行（冪等）
--  方針:
--   admin(app_user.role='admin') = 全施設の読み書き
--   member = user_facility に登録された施設のみ読み書き
--   マスタ(dim_facility等) = 全員読める / 書けるのはadminのみ
--   app_user / user_facility = 本人とadminのみ読める / 書き込みはAPI(service_role)経由のみ
--   mart_ ビュー = security_invoker で下表のRLSを継承
--  【実行前チェック】以下で自分が admin で登録済みなことを必ず確認:
--    select user_id, email, role from app_user where role = 'admin';
-- ============================================================

-- ---- 権限判定関数（SECURITY DEFINERでapp_user/user_facilityを参照） ----
create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as
$$ select exists (select 1 from app_user where user_id = auth.uid() and role = 'admin') $$;

create or replace function public.can_access_facility(f text) returns boolean
language sql stable security definer set search_path = public as
$$ select public.is_admin()
       or exists (select 1 from user_facility where user_id = auth.uid() and facility = f) $$;

grant execute on function public.is_admin() to authenticated;
grant execute on function public.can_access_facility(text) to authenticated;

-- ---- 施設スコープ表（FOR ALL: 該当施設の読み書き） ----
do $$
declare
  spec text[][] := array[
    -- [テーブル名, 施設カラム]
    ['raw_reservation','facility'], ['raw_basic_product','facility'],
    ['raw_other_product','facility'], ['raw_payment','facility'],
    ['raw_booking_event','facility'], ['raw_rate_snapshot','facility'],
    ['raw_room_sales','facility'], ['dim_budget','facility'],
    ['dim_ota_marketing','facility'], ['dim_operating_days','facility'],
    ['dim_productivity_manual','facility'], ['budget_daily','facility'],
    ['budget_monthly','facility'], ['actual_monthly','facility'],
    ['raw_daily_plan_context','facility'],
    ['raw_attendance_daily','work_facility'], ['raw_shift_plan','work_facility'],
    ['dim_staff','home_facility']
  ];
  rec text[]; pol record;
begin
  foreach rec slice 1 in array spec loop
    if to_regclass('public.' || rec[1]) is null then continue; end if;
    execute format('alter table %I enable row level security', rec[1]);
    for pol in select policyname from pg_policies where schemaname = 'public' and tablename = rec[1] loop
      execute format('drop policy %I on %I', pol.policyname, rec[1]);
    end loop;
    execute format(
      'create policy %I on %I for all to authenticated using (public.can_access_facility(%I)) with check (public.can_access_facility(%I))',
      rec[1] || '_facility_scope', rec[1], rec[2], rec[2]);
  end loop;
end $$;

-- ---- AIキャッシュ（読みのみ施設スコープ。書き込みはAPI=service_roleのみ） ----
do $$
declare t text; pol record;
begin
  foreach t in array array['ai_summary','ai_issue'] loop
    if to_regclass('public.' || t) is null then continue; end if;
    execute format('alter table %I enable row level security', t);
    for pol in select policyname from pg_policies where schemaname = 'public' and tablename = t loop
      execute format('drop policy %I on %I', pol.policyname, t);
    end loop;
    execute format(
      'create policy %I on %I for select to authenticated using (public.can_access_facility(facility))',
      t || '_facility_read', t);
  end loop;
end $$;

-- ---- シフトセグメント（親のraw_shift_plan経由で施設判定） ----
do $$
declare pol record;
begin
  if to_regclass('public.raw_shift_segment') is not null then
    alter table raw_shift_segment enable row level security;
    for pol in select policyname from pg_policies where schemaname = 'public' and tablename = 'raw_shift_segment' loop
      execute format('drop policy %I on raw_shift_segment', pol.policyname);
    end loop;
    create policy raw_shift_segment_via_plan on raw_shift_segment
      for all to authenticated
      using (exists (select 1 from raw_shift_plan p where p.shift_id = raw_shift_segment.shift_id
                       and public.can_access_facility(p.work_facility)))
      with check (exists (select 1 from raw_shift_plan p where p.shift_id = raw_shift_segment.shift_id
                            and public.can_access_facility(p.work_facility)));
  end if;
end $$;

-- ---- マスタ（全員read / 書き込みはadminのみ） ----
do $$
declare t text; pol record;
begin
  -- dim_shift_pattern は「各宿設定」で施設スコープ編集にしたため master 扱いから除外（shift_pattern_settings.sql が正）
  foreach t in array array['dim_facility','dim_facility_mapping','dim_role'] loop
    if to_regclass('public.' || t) is null then continue; end if;
    execute format('alter table %I enable row level security', t);
    for pol in select policyname from pg_policies where schemaname = 'public' and tablename = t loop
      execute format('drop policy %I on %I', pol.policyname, t);
    end loop;
    execute format('create policy %I on %I for select to authenticated using (true)', t || '_read_all', t);
    execute format('create policy %I on %I for insert to authenticated with check (public.is_admin())', t || '_write_admin_i', t);
    execute format('create policy %I on %I for update to authenticated using (public.is_admin()) with check (public.is_admin())', t || '_write_admin_u', t);
    execute format('create policy %I on %I for delete to authenticated using (public.is_admin())', t || '_write_admin_d', t);
  end loop;
end $$;

-- ---- 権限テーブル（本人とadminのみread。書き込みはAPI=service_roleのみ） ----
do $$
declare t text; pol record;
begin
  foreach t in array array['app_user','user_facility'] loop
    if to_regclass('public.' || t) is null then continue; end if;
    execute format('alter table %I enable row level security', t);
    for pol in select policyname from pg_policies where schemaname = 'public' and tablename = t loop
      execute format('drop policy %I on %I', pol.policyname, t);
    end loop;
    execute format(
      'create policy %I on %I for select to authenticated using (user_id = auth.uid() or public.is_admin())',
      t || '_self_or_admin', t);
  end loop;
end $$;

-- ---- mart_ ビューを security_invoker 化（閲覧者の権限でRLS評価） ----
--   自前ゲート(invoker=off)のビューは除外: mart_labor_cost_monthly / mart_shift_variance_monthly
--   （security_invoker_fix.sql でゲート付与）、mart_meal_monthly（materialize_marts.sql 適用時はoff＋ゲート）
do $$
declare v record;
begin
  for v in select viewname from pg_views where schemaname = 'public'
             and viewname like 'mart_%'
             and viewname not in ('mart_labor_cost_monthly', 'mart_shift_variance_monthly', 'mart_meal_monthly') loop
    execute format('alter view %I set (security_invoker = on)', v.viewname);
  end loop;
end $$;

-- ---- 動作確認（実行後に流す）----
-- select count(*) from pg_policies where schemaname='public';   -- ポリシー総数
-- select viewname, (select option_value from pg_options_to_table(c.reloptions) o where option_name='security_invoker')
--   from pg_views v join pg_class c on c.relname = v.viewname where schemaname='public' and viewname like 'mart_%';
