@AGENTS.md

# プロジェクト方針

このプロジェクトのUI実装は `/docs/UI仕様書.md` に従うこと。
データベース設計は `/docs/データベース設計書.md` に従うこと。
要件は `/docs/要件定義書.md` を参照すること。

本番環境はSupabaseを使用。**localStorageは使わない**（データ・UI状態とも。施設選択はCookieで保持する）。

## 環境メモ
- 本番URL: https://yadorie-revenue-analytics-beta.vercel.app
- ホスティング: Vercel（個人アカウント takeuchi-svg / mainブランチへのpushで自動デプロイ）
- 作業ブランチ: main
- Gitコミットメール: takeuchi@okamijuku.com（GitHubアカウントと一致させること）
- ログインユーザー: takeuchi@okamijuku.com
- 先行施設: FRY（山の手ホテル）

# シフト・労務管理機能（v1）

> 既存KPIダッシュボードと同一リポジトリ・同一Supabase。シフトは新セクションとして追加。
> 着手前に必ず `docs/` を読む: 要件定義書_シフト労務管理v1 → 仕様書_シフト労務管理v1 → `ddl_shift_labor_v1.sql` → `erd.md` → `implementation_plan.md` → `claude_code_tickets.md`。
> 進め方: `claude_code_tickets.md` を T00 から1チケットずつ（読む→実装→DoD→報告→次へ）。docs が唯一の正。

## 最重要ルール（DBは共有。壊さない）
- **既存テーブルを再利用し複製しない**: `dim_staff`（賃金項目をALTER追加）、`raw_attendance_daily`（=実績。T01で `source` 列をALTER追加）、`dim_facility_mapping`、`budget_daily`。
- **新規はこれだけ**: `dim_role`, `dim_shift_pattern`, `raw_shift_plan`, `raw_shift_segment`, `raw_daily_plan_context` ＋ ビュー `mart_shift_variance` / `mart_labor_cost_actual` / `mart_labor_cost_monthly` / `mart_labor_cost_plan` / `mart_daily_plan_context`。
- **キー**: 従業員=`staff_code`(TEXT・KOTコード)、施設=`work_facility`/`facility`(TEXT・BIコード=`dim_facility_mapping.facility`)。時間は分(整数)。命名 `raw_`/`dim_`/`mart_`。
- **予実**: 予=`raw_shift_plan.planned_minutes`、実=`raw_attendance_daily.total_work_min`。突合キー `(staff_code, work_facility, work_date)`。
- **施設はデータであってスキーマではない**: 施設追加でDDL変更不要。施設固有パターンは `dim_shift_pattern.facility`（NULL=全社共通）。

## 人件費・残業
- 時給者: `実働時間×hourly_wage`。月給者: `monthly_salary + max(0, 月労働−contracted_monthly_hours−deemed_ot_hours)×(monthly_salary/contracted_monthly_hours×1.25)`。スポットは時給扱い。
- **割増は1.25のみ**（深夜・法定休日割増は実装しない）。賃金はv1では `dim_staff` の現行値（履歴化はv2）。

## スポット（派遣/タイミー）
- `dim_staff` に `is_spot=true`＋`hourly_wage` で登録（KOTコードなし）。実働はシフト画面から手入力→`raw_attendance_daily`(`source='manual'`)。**スポット判定は `dim_staff.is_spot`**（attendanceにis_spot列は持たない）。既存KOT行は `source='KOT'`。

## 本repo実態と設計の差分（重要）
- **`mart_productivity` ビューは存在しない**。生産性KPIは `productivity` ページでクライアント集計、手入力2項目は `dim_productivity_manual`（設定画面）。
- **T00確認済**: `budget_daily` は 施設列=`facility`(BIコード) / 日付列=`date`（`work_date`ではない）。`mart_daily_plan_context` は date→work_date 別名結合で調整済み。

## KPI改修（T13・二重計上防止・必須。T11の後）
- 施設×月ロールアップ `mart_labor_cost_monthly`（`sum(ot_pay_over_deemed)`=みなし残業超残業代 / `sum(spot_hours)`=派遣その他時間）を新設。
- `productivity` ページの当該2指標を `dim_productivity_manual` 手入力から `mart_labor_cost_monthly` 参照へ差し替え。設定画面の当該2項目の入力UIを廃止（列・備考は残す）。

## マスタは設定で編集可
- `dim_role` / `dim_shift_pattern` は設定画面から追加・変更（`color`/`sort_order`/`is_active`）。初期seedはDDL＋`implementation_plan.md` §2。
