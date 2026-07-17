-- ============================================================
--  予約日ベース分析・施策記録  Step A（データ基盤）
--  Supabase SQL Editor で全文 Run（冪等）。要件定義書_予約日ベース分析_施策記録 §2,§6(M1/M2/M4)。
--
--  方針: ステイシー予約情報(raw_reservation)に一本化。新テーブルは snapshot_onhand と
--        raw_marketing_action の2つのみ。予約日ベースの集計は既存カラムから導出（新テーブル不要）。
--
--  ★前提: キャンセル日(cancel_date)を新設する。取込ETL(transform.ts)側の実CSVヘッダ名を確定してから
--         パーサを繋ぐ（Step B）。列だけ先に用意し、ビューは cancel_date を参照する（未取込の間は
--         キャンセルが日付未確定＝ネット/カーブのキャンセル側が0になり、新規予約側のみ正しく出る）。
-- ============================================================

-- ------------------------------------------------------------
-- [1] raw_reservation にキャンセル日を追加（§2.1 カーブ再構築の必須列）
--     既存の booking_date(予約日) は取込済。cancel_date のみ不足していた。
-- ------------------------------------------------------------
ALTER TABLE raw_reservation ADD COLUMN IF NOT EXISTS cancel_date DATE;
CREATE INDEX IF NOT EXISTS idx_res_facility_booking ON raw_reservation(facility, booking_date);
CREATE INDEX IF NOT EXISTS idx_res_facility_cancel  ON raw_reservation(facility, cancel_date);

-- ------------------------------------------------------------
-- [2] snapshot_onhand（オンハンド断面・追記専用）§2.2
--     週1取込のたびに、その時点のオンハンド断面を追記。UPDATEしない（同一断面の再取込のみ上書き）。
--     channel は UNIQUE キーに含めるため NOT NULL（不明は '不明'）。
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS snapshot_onhand (
  id            BIGSERIAL PRIMARY KEY,
  facility      TEXT NOT NULL REFERENCES dim_facility(facility),
  snapshot_date DATE NOT NULL,                 -- 取込した日（断面の日付）
  stay_date     DATE NOT NULL,                 -- 宿泊日
  channel       TEXT NOT NULL DEFAULT '不明',   -- チャネル（扱先）
  rooms         INTEGER,                        -- その時点で入っている室数
  guests        INTEGER,
  revenue       INTEGER,
  created_at    TIMESTAMPTZ DEFAULT now(),
  UNIQUE (facility, snapshot_date, stay_date, channel)
);
CREATE INDEX IF NOT EXISTS idx_snap_fac_stay ON snapshot_onhand(facility, stay_date, snapshot_date);

-- ------------------------------------------------------------
-- [3] raw_marketing_action（施策記録）§2.3
--     判断日(decided_date)と実行開始日(start_date)を分けて持つ。効果の主観評価カラムは持たない。
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS raw_marketing_action (
  id               BIGSERIAL PRIMARY KEY,
  facility         TEXT NOT NULL REFERENCES dim_facility(facility),
  channel          TEXT,                        -- 対象OTA（じゃらん/楽天/一休/Booking/自社/全体…）
  action_type      TEXT NOT NULL,               -- 広告 | クーポン | セール参加 | ランク変更 | プラン | その他
  title            TEXT NOT NULL,               -- 例:「じゃらんお得な10日間」
  decided_date     DATE,                        -- 判断した日
  start_date       DATE NOT NULL,               -- 実行開始日
  end_date         DATE,                        -- 実行終了日（単日施策は start=end）
  cost             INTEGER,                     -- 費用（円。不明/無料は NULL）
  target_stay_from DATE,                        -- 対象宿泊期間（あれば）
  target_stay_to   DATE,
  memo             TEXT,
  created_by       TEXT,
  created_at       TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mkt_action_fac ON raw_marketing_action(facility, start_date);

-- ------------------------------------------------------------
-- [4] RLS（新テーブル2つを施設スコープ化。rls_facility.sql と同方式）
--     can_access_facility(): admin=全施設 / member=user_facility 登録施設のみ。
-- ------------------------------------------------------------
do $$
declare t text; pol record;
begin
  foreach t in array array['snapshot_onhand','raw_marketing_action'] loop
    execute format('alter table %I enable row level security', t);
    for pol in select policyname from pg_policies where schemaname='public' and tablename=t loop
      execute format('drop policy %I on %I', pol.policyname, t);
    end loop;
    execute format(
      'create policy %I on %I for all to authenticated using (public.can_access_facility(facility)) with check (public.can_access_facility(facility))',
      t || '_facility_scope', t);
  end loop;
end $$;

-- ============================================================
--  ビュー（raw_reservation から導出。security_invoker=on で raw_reservation の RLS を継承）
-- ============================================================

-- ------------------------------------------------------------
-- [5] mart_booking_flow — 予約日ベースのフロー（§2.1）
--     施設 × フロー日 × チャネル で:
--       新規予約（予約日 booking_date で計上・販売不可/空部屋は非予約として除外）
--       キャンセル（キャンセル日 cancel_date で計上）
--       ネット = 新規 − キャンセル
--     室数系は 1予約=1室×泊数（room_count は全件1固定で使用禁止のため nights を使う）。
-- ------------------------------------------------------------
CREATE OR REPLACE VIEW mart_booking_flow AS
WITH ev AS (
  -- 新規予約（予約日で計上）: キャンセル済みも「予約は入った」ので新規側に含める
  SELECT facility,
         booking_date              AS flow_date,
         COALESCE(channel,'不明')  AS channel,
         1                                       AS new_res,
         GREATEST(nights,1)                      AS new_rn,
         COALESCE(revenue_settled,0)             AS new_rev,
         0 AS cxl_res, 0 AS cxl_rn, 0 AS cxl_rev
  FROM raw_reservation
  WHERE booking_date IS NOT NULL
    AND status NOT IN ('販売不可','空部屋')
  UNION ALL
  -- キャンセル（キャンセル日で計上）
  SELECT facility,
         cancel_date               AS flow_date,
         COALESCE(channel,'不明')  AS channel,
         0, 0, 0,
         1,
         GREATEST(nights,1),
         COALESCE(revenue_settled,0)
  FROM raw_reservation
  WHERE status = 'キャンセル' AND cancel_date IS NOT NULL
)
SELECT
  facility, flow_date, channel,
  SUM(new_res)                     AS new_reservations,
  SUM(new_rn)                      AS new_room_nights,
  SUM(new_rev)                     AS new_revenue,
  SUM(cxl_res)                     AS cxl_reservations,
  SUM(cxl_rn)                      AS cxl_room_nights,
  SUM(cxl_rev)                     AS cxl_revenue,
  SUM(new_res) - SUM(cxl_res)      AS net_reservations,
  SUM(new_rn)  - SUM(cxl_rn)       AS net_room_nights,
  SUM(new_rev) - SUM(cxl_rev)      AS net_revenue
FROM ev
GROUP BY facility, flow_date, channel;
ALTER VIEW mart_booking_flow SET (security_invoker = on);

-- ------------------------------------------------------------
-- [6] mart_onhand — 現在のオンハンド断面（§3.4）
--     宿泊日 >= 今日 かつ 未キャンセル（未確認/予約確定/重要予約/C/O）を、宿泊日×チャネルで積み上げ。
--     連泊は1泊ずつ宿泊日に展開（3泊予約=3宿泊日を1室ずつ埋める）。金額は泊数で按分。
-- ------------------------------------------------------------
CREATE OR REPLACE VIEW mart_onhand AS
SELECT
  r.facility,
  (r.checkin + gs.n)::date         AS stay_date,
  COALESCE(r.channel,'不明')       AS channel,
  COUNT(*)                         AS rooms,                                   -- 1予約=1室/泊
  SUM(COALESCE(r.guests_total,0))  AS guests,
  SUM(ROUND(COALESCE(r.revenue_settled,0)::numeric / GREATEST(r.nights,1)))::int AS revenue
FROM raw_reservation r
CROSS JOIN LATERAL generate_series(0, GREATEST(r.nights,1) - 1) AS gs(n)
WHERE r.status IN ('未確認','予約確定','重要予約','C/O')
  AND (r.checkin + gs.n) >= CURRENT_DATE
GROUP BY r.facility, (r.checkin + gs.n)::date, COALESCE(r.channel,'不明');
ALTER VIEW mart_onhand SET (security_invoker = on);

-- ------------------------------------------------------------
-- [7] mart_booking_curve — ブッキングカーブ再構築の素（§2.1）
--     予約1件を宿泊日ごとに1泊=1室へ展開し、予約日・キャンセル日・リード日数を保持する。
--     任意時点Tの断面は画面側で復元:
--       宿泊日D・時点T(=D-k)の予約数
--         = COUNT(*) WHERE stay_date=D AND booking_date <= T AND (cancel_date IS NULL OR cancel_date > T)
--     → 毎日のスナップショット取得は不要（予約日×キャンセル日から数学的に復元）。
-- ------------------------------------------------------------
CREATE OR REPLACE VIEW mart_booking_curve AS
SELECT
  r.facility,
  (r.checkin + gs.n)::date                     AS stay_date,
  COALESCE(r.channel,'不明')                   AS channel,
  r.booking_date,
  r.cancel_date,
  ((r.checkin + gs.n)::date - r.booking_date)  AS lead_days,   -- 宿泊日−予約日
  1                                            AS rooms,
  ROUND(COALESCE(r.revenue_settled,0)::numeric / GREATEST(r.nights,1))::int AS revenue
FROM raw_reservation r
CROSS JOIN LATERAL generate_series(0, GREATEST(r.nights,1) - 1) AS gs(n)
WHERE r.status NOT IN ('販売不可','空部屋')
  AND r.booking_date IS NOT NULL;
ALTER VIEW mart_booking_curve SET (security_invoker = on);

-- ============================================================
--  確認用
--   select * from mart_booking_flow  where facility='FRY' order by flow_date desc limit 20;
--   select * from mart_onhand        where facility='FRY' order by stay_date limit 20;
--   select stay_date, count(*) from mart_booking_curve where facility='FRY'
--     and stay_date = DATE '2026-08-01'
--     and booking_date <= DATE '2026-07-01'
--     and (cancel_date is null or cancel_date > DATE '2026-07-01')
--     group by stay_date;   -- 2026-08-01 の D-31 時点オンハンド
--   select count(*) from pg_policies where schemaname='public' and tablename in ('snapshot_onhand','raw_marketing_action');
-- ============================================================
