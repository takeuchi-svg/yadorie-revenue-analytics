# Claude Code 作業チケット（シフト・労務管理 v1）

各チケットはそのまま Claude Code に1つずつ貼れる粒度。上から順に。共通前提: 既存repo（KPIアプリ拡張）・同一Supabase。既存テーブルは複製しない。着手前に `docs/`（要件定義書→仕様書→ddl→erd）を読むこと。

---

## T00 — budget_daily 列名確認とビュー調整
- 目的: 予算結合を実DBに合わせる。
- 読む: `仕様書` §3.4, `ddl` K節。
- 手順: `budget_daily` の施設列・日付列・`rooms_sold`/`guests` を確認 → `mart_daily_plan_context` を実列名に修正。
- 完了条件: `select * from mart_daily_plan_context limit 5;` が予算＋（あれば）手入力を返す。
- 依存: なし。

## T01 — マイグレーション適用（ALTER＋新規テーブル＋ビュー）
- 目的: スキーマ構築。
- 読む: `ddl_shift_labor_v1.sql` 全体。
- 手順: DDLをマイグレーションとして適用。
  - `dim_staff` ALTER（賃金項目）。
  - **`raw_attendance_daily` ALTER: `source text not null default 'KOT'` を追加**（既存行=KOT。is_spotは足さずスポットは `dim_staff.is_spot` で判定）。
  - 新規: `dim_role`/`dim_shift_pattern`/`raw_shift_plan`/`raw_shift_segment`/`raw_daily_plan_context`。
  - ビュー: `mart_shift_variance`/`mart_labor_cost_actual`/**`mart_labor_cost_monthly`**/`mart_labor_cost_plan`/`mart_daily_plan_context`。
- 完了条件: 全オブジェクト作成。`mart_shift_variance` が空SELECT可。既存テーブルは無変更（ALTER以外）。`raw_attendance_daily.source` の既存行が 'KOT'。
- 依存: T00。

## T02 — マスタseed（役割・勤務パターン）
- 目的: 初期マスタ投入（設定で後から編集可）。
- 読む: `implementation_plan` §2。
- 手順: §2のseed SQLを投入。ナイトは日跨ぎ（`work_minutes=(end+24h)-start-break`）である旨をコードのコメントに残す。
- 完了条件: `dim_role` 7件、`dim_shift_pattern` 勤務4件＋休日2件。
- 依存: T01。

## T03 — 賃金マスタ投入と人件費検算
- 目的: `dim_staff` の賃金項目を設定し、人件費計算を検証。
- 読む: `仕様書` §3.2。
- 手順: 各従業員の `wage_type/hourly_wage/monthly_salary/deemed_ot_hours/contracted_monthly_hours` を投入（月給者は所定・見込み残業必須）。
- 完了条件: `mart_labor_cost_actual` が既存実績で妥当な人件費・`ot_pay_over_deemed`・`spot_hours` を返す。手計算1名分と一致。
- 依存: T01。

## T04 — データアクセス層
- 目的: シフトの読み書きAPI。
- 手順: (a) 月次ロード（`raw_shift_plan`＋`raw_shift_segment`＋`mart_daily_plan_context`）、(b) 保存 upsert `(staff_code, work_facility, work_date)`、(c) 分割保存時に segment 再生成＋`planned_minutes` を合計へ同期。
- 完了条件: 1施設1か月の読み書き往復が通る。
- 依存: T01。

## T05 — UIシェル＆ルーティング
- 目的: 既存アプリにシフトセクション追加。
- 手順: ルート/ナビ追加、施設・月セレクタ、保存ボタン。既存の認証・Supabaseクライアント・デザインを再利用。
- 完了条件: 空グリッドが表示され施設/月切替できる。
- 依存: T04。

## T06 — 稼働前提パネル
- 目的: 予算・オンハンド・予測・メモ。
- 読む: `仕様書` §4.2。参考: `shift_ui_mock.html`。
- 手順: 折りたたみパネル。予算＝自動（`mart_daily_plan_context`）、オンハンド/予測/メモ＝手入力保存（`raw_daily_plan_context`）。メモは2文字表示＋ホバー全文。
- 完了条件: 入力が保存・再ロードで復元。
- 依存: T05。

## T07 — 月グリッド本体（即時集計）
- 目的: 中核の入力。
- 読む: `仕様書` §4.3–4.5。参考: `shift_ui_mock.html`。
- 手順: 従業員フラット表示（部署分けなし）、セル＝パターン`select`＋時間`input`（勤務時のみ活性・色反映）、右端 労働時間計/休日数、フッタ 日別合計。編集で即時再計算。
- 完了条件: モック相当の操作で保存→再ロード復元。集計がリアルタイム。
- 依存: T04, T05。

## T08 — 役割分割エディタ
- 目的: 時間帯×役割の分割。
- 手順: セルから segment 編集（開始/終了/役割/休憩）。`planned_minutes` を合計へ同期。非分割日は1コマ扱い。
- 完了条件: 分割の保存・再ロード・合計一致。
- 依存: T07。

## T09 — 前月コピー（曜日合わせ）
- 目的: 高速作成。
- 手順: 前月シフトを**同一曜日**にマッピングして投入（日付番号ではなく曜日基準）。
- 完了条件: 前月→当月が曜日基準で複製される。
- 依存: T07。

## T10 — Excel風コピー＆ペースト
- 目的: セル複製の高速化。
- 手順: セル範囲選択→コピー／貼付。貼付後も時間手修正可。
- 完了条件: 複数セルのコピペが動作。
- 依存: T07。

## T11 — スポット要員（追加＆実働入力）
- 目的: 派遣/タイミー対応。
- 読む: `仕様書` §2.6, §4。
- 手順: `dim_staff` に `is_spot=true`＋時給で登録するUI。実働は人×日で入力→`raw_attendance_daily`(`source='manual'`, is_spot)。
- 完了条件: スポット実働が総労働時間・人件費・KPIに反映。KOT行と衝突しない。
- 依存: T03, T07。

## T12 — 月次サマリー＆計画人件費
- 目的: 月次合計表示。
- 手順: 労働時間合計/人件費合計/うち派遣その他時間。計画人件費は `mart_labor_cost_plan` を配線。人ごと人件費は非表示。
- 完了条件: サマリーが即時更新。
- 依存: T07, T03。

## T13 — KPI改修（二重計上防止・必須）
- 目的: 旧手入力の廃止と単一ソース化。
- 読む: `要件定義書` §6.4, `仕様書` §3.3。
- 【本repo実態】`mart_productivity` ビューは無い。生産性KPIは `productivity` ページでクライアント集計、
  手入力2項目は `dim_productivity_manual`（設定画面）。よって改修は以下に読み替え:
- 手順:
  1. ビュー **`mart_labor_cost_monthly`（施設×月, T01で作成）** を用意。
  2. `productivity` ページの「みなし残業超の残業代」「派遣・その他の労働時間」を、
     `dim_productivity_manual` 手入力から **`mart_labor_cost_monthly`（deemed_ot_excess_pay / spot_hours）参照**へ差し替え。
  3. 設定画面(`settings`)の当該2項目の**入力UIを廃止**（`dim_productivity_manual` の列・備考 dispatch_other_notes は残す）。
  4. 総労働時間は既存 `mart_labor_monthly` 由来で source を問わずスポットも含む。手入力2項目を除外し二重計上を防ぐ。
- 完了条件: KPIの残業代・派遣時間・総労働時間が新ソースのみで算出。旧手入力UIが無くなり値が重複しない。
- 依存: T03, T11。

## T14 — 検証
- 目的: 受け入れ確認。
- 手順: 予実（欠勤/計画外出勤の検出）、人件費（時給/月給OT/スポット）、マルチ施設（2施設以上）でサンプル月を手計算と突合。
- 完了条件: すべて一致。
- 依存: T07–T13。
