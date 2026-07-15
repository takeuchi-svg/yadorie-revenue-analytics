-- ============================================================
--  全社Core: 開業日/取得日 (opening_date) を dim_facility に追加
--  Supabase SQL Editor で全文 Run（冪等）
--
--  用途: 全社PL分析の基本軸「全店 / 既存店 / 新店」を判定する。
--        13ヶ月ルール = 開業/取得から13ヶ月以上経過した施設を「既存店」
--        （前年同月が揃い前年比が意味を持つ）、12ヶ月以内を「新店」とする。
--        判定ロジックは src/lib/company/facility-class.ts（当月を基準に算出）。
--  値: 開業日 or 取得日のうち「運営を開始した日」。月初日でよい（日は判定に不使用）。
--
--  ※ 27施設分の実データ投入は company_opening_date_seed.sql（開業日リスト受領後に作成）。
-- ============================================================

alter table dim_facility add column if not exists opening_date date;

comment on column dim_facility.opening_date is
  '開業日/取得日。全店・既存店・新店の判定(13ヶ月ルール)に使用。NULL=未設定は当面「新店扱いにせず区分不明」として全店のみ集計';

-- 確認: select facility, name, opening_date from dim_facility order by opening_date nulls last;
-- ロールバック: alter table dim_facility drop column if exists opening_date;
