-- ============================================================
--  AIナレッジ基盤 K30 修正 ── ai_reader が mart_ai を読めるようにする
--  Supabase SQL Editor で全文 Run（冪等）。mart_ai_setup.sql 実行後が前提。
--
--  背景: mart_ai のパススルービュー（例 mart_ai.mart_monthly_kpi = select * from
--   public.mart_monthly_kpi）は、内部で security_invoker=on の public ビューを経由し、
--   大元のテーブル(raw_reservation 等)を ai_reader 権限で読もうとして permission denied
--   になっていた（症状: 灯が「アクセス権限エラー」で通常質問に答えられない）。
--
--  方針（給与守秘は維持）:
--   - ai_reader に BYPASSRLS ＋ 非機密ベーステーブルのSELECTを付与
--   - 給与・人件費絶対額・個人情報(dim_staff/dim_staff_wage/mart_labor_cost_*/actual_monthly/
--     budget_monthly/dim_productivity_manual 等)は **付与しない**。これらは k-匿名マスク済みの
--     mart_ai ビュー(owner読み)経由でしか到達できない状態を保つ。
-- ============================================================

-- RLS をスキップ（ただしテーブルSELECT権限が無ければ読めない＝下の付与が実際の可視範囲）
alter role ai_reader bypassrls;

-- 非機密の base テーブルにSELECT付与（宿泊・販売・稼働・料飲・日次予算・勤怠時間・マスタ）
--  ※給与/PL人件費/個人マスタは含めない
grant select on
  public.raw_reservation,
  public.raw_room_sales,
  public.raw_basic_product,
  public.raw_other_product,
  public.budget_daily,
  public.raw_attendance_daily,   -- 時間のみ(金額なし)。mart_labor_monthlyの供給元
  public.dim_facility,
  public.dim_operating_days
to ai_reader;

-- 予算売上ビューは budget_monthly(人件費科目を含む)を経由するため、
-- mart_ai 側で「売上科目のみ」を owner 読みするよう再定義（budget_monthly は ai_reader に非付与のまま）
create or replace view mart_ai.mart_budget_revenue_monthly as
  select facility, month, amount as revenue_budget
  from public.budget_monthly
  where item_code = 'sales_total';

-- mart_ai 全ビューのSELECTを再付与（再定義分を含む）
grant select on all tables in schema mart_ai to ai_reader;

-- ---- 検証（Run後にこの2つを実行して結果を教えてください） ----
-- 1) 通常データが読める（3行の数字が出ればOK）
-- grant ai_reader to postgres;  -- 既に実行済みなら不要
-- set role ai_reader;
-- select facility, month, revenue from mart_ai.mart_monthly_kpi where facility='FRY' order by month desc limit 3;
-- reset role;
-- 2) 給与守秘は維持（すべて false ならOK）
-- select has_table_privilege('ai_reader','public.dim_staff_wage','select')       as 個人給与,
--        has_table_privilege('ai_reader','public.actual_monthly','select')       as PL人件費_生,
--        has_table_privilege('ai_reader','public.mart_labor_cost_monthly','select') as 人件費合計;
