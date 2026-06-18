---
name: budget-import
description: 年度予算・実績を計画スプレッドシート（Googleスプレッドシート）からSupabaseに取り込む。2025年度/2026年度のbudget_daily・budget_monthly・actual_monthlyを更新したいときに使う。「予算を取り込む」「予実を更新」「来年度予算をDBに入れる」等のリクエストで起動。
---

# 予算・実績スプレッドシート取込

計画スプレッドシート（③日別計画/③日別売上、⑤月次計画、⑦予実管理）から
Supabase に予算・実績を取り込む手順。

## 対象スプレッドシート（fileId）
- 2026年度: `13Ibc8qmD_ebWjDPbxxlyVbPl3u_Wlst5u8-Db9cWL5E`
- 2025年度: `1MHIeJZp9_gHt5c5U1TJu1CoJbvhcl_cUoeWCGuPofOE`
- 他施設/他年度は同フォーマットの計画シートの fileId を使う。

## 取込先テーブル
- `budget_daily`   ← ③日別計画（2026形式: 全列）/ ③日別売上（2025形式: 客単価/人数室/室単価/稼働率/売上のみ。室数=稼働率×総室数で補完）
- `budget_monthly` ← ⑤月次計画（フルP&L, EAV。item_code='sales_total'が売上高計。2025は行ラベル「売上」、2026は「売上高 計」→どちらもsales_totalにマップ済み）
- `actual_monthly` ← ⑦予実管理（実績・昨年。各月6列: 実績/予算/予算差異/昨年/昨年差異/売上対比）

## 手順
1. Google Drive MCP で xlsx をダウンロード（大きいのでファイル保存される）:
   `download_file_content(fileId, exportMimeType='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')`
   → 返り値の保存先 .txt パス（JSON {content: base64}）を控える。
2. 取込実行（.env.local から service_role 鍵を読む。REST upsert）:
   ```
   node scripts/import-budget.mjs <保存先.txt> <facility> <fiscalYear>
   # 例: node scripts/import-budget.mjs ./dl.txt FRY 2025
   ```
   - facility: 施設コード（FRY 等）
   - fiscalYear: 年度（'2025' = 2025/04〜2026/03）
3. 検証: `mart_budget_revenue_monthly`（sales_total）や `budget_daily` の件数を確認。

## 前提・注意
- **DB直結（pg 5432）はこの開発環境からDNS不通**。テーブル新規作成（DDL）は Supabase SQL Editor で実行する（`scripts/budget-schema.sql` / `scripts/migrate.mjs` 参照）。データINSERTはREST(service_role)で可能。
- スクリプトは両フォーマット（2025/2026）を自動判別する（シート名 日別計画/日別売上、ラベル 売上/売上高計）。
- 予算更新時はスプレッドシートを直し、同じ手順で再取込（upsertで重複しない）。
- 関連: 予実管理ページ `/yojitsu`、Overview 予算達成率、日別売上の予算比較軸が取込データを参照する。
