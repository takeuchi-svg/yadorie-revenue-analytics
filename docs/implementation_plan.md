# 実装計画（シフト・労務管理 v1）

既存KPIアプリの拡張。上から順に実装する。各段の完了条件（DoD）を満たしてから次へ。

## 0. 事前確認
- `budget_daily` の施設列名・日付列名を確認。`ddl_shift_labor_v1.sql` K節ビューを実列名へ調整。
- DoD: `select facility, work_date, rooms_sold, guests from budget_daily limit 1;` が通る。

## 1. マイグレーション（DDL適用）
- `ddl_shift_labor_v1.sql` を適用（`dim_staff` ALTER＋新規テーブル/ビュー）。
- DoD: 全テーブル/ビューが作成され、`mart_shift_variance` が空でSELECTできる。

## 2. マスタ初期データ（seed・設定で後から編集可）
```sql
insert into dim_role (role_name, sort_order) values
 ('フロント',10),('客室清掃',20),('朝食',30),('パントリー',40),('夜警',50),('バス',60),('施設管理',70);

insert into dim_shift_pattern (pattern_type,name,start_time,end_time,break_minutes,color,sort_order) values
 ('勤務','早番','07:00','16:00',60,'#378ADD',10),
 ('勤務','中番','12:00','21:00',60,'#639922',20),
 ('勤務','遅番','12:30','21:30',60,'#BA7517',30),
 ('勤務','ナイト','16:00','10:00',120,'#7F77DD',40);
-- 休日パターン（公休/有給）はDDLで投入済み。
```
- ナイトは日跨ぎ。`work_minutes = (end+24h) − start − break` で計算。
- DoD: 設定画面（後段）でこれらが一覧・編集できる。

## 3. 賃金マスタ投入
- `dim_staff` の `wage_type/hourly_wage/monthly_salary/deemed_ot_hours/contracted_monthly_hours` を各人へ設定（月給者は所定・見込み残業必須）。
- DoD: `mart_labor_cost_actual` が既存実績に対し妥当な人件費を返す。

## 4. データアクセス層
- シフト月次ロード（`raw_shift_plan`＋`raw_shift_segment`＋`mart_daily_plan_context`）。
- シフト保存: upsert `(staff_code, work_facility, work_date)`。分割時は segment を再生成し `planned_minutes` を合計へ同期。
- DoD: 1施設1か月の読み書きが往復できる。

## 5. UI（シフトセクション。既存アプリのシェル/認証/デザインを再利用）
- ツールバー（施設/月/前月コピー/短期追加/設定/保存）。
- 稼働前提パネル（折りたたみ）: 予算(自動)・オンハンド・予測・メモ（2文字＋ホバー全文）。
- 月グリッド（フラット・部署分けなし）: パターン`select`＋時間`input`（勤務時のみ活性・色反映）、右端に労働時間計/休日数、フッタに日別合計。
- 役割分割エディタ（`raw_shift_segment`）。
- 月次サマリー（労働時間/人件費/派遣その他時間）、**即時再計算**。
- 参考UI: `shift_ui_mock.html`。
- DoD: モック相当の操作で保存→再ロードで復元。

## 6. コピー機能
- 前月コピー（**曜日合わせ**マッピング）。Excel風コピー＆ペースト。貼付後の時間手修正可。
- DoD: 前月から同一曜日でシフトが複製される。

## 7. スポット実働入力
- スポット要員の実働を人×日で入力 → `raw_attendance_daily`(`source='manual'`, is_spot)。
- DoD: 入力分が総労働時間・人件費・KPIに反映。

## 8. KPI改修（二重計上防止・必須）※実装で読み替え（T13）
- `mart_productivity` は存在しないため、施設×月ロールアップ **`mart_labor_cost_monthly`** を新設し、productivity ページの2指標（みなし残業超残業代／派遣時間）をそこへ差し替え。
- 設定の**手入力2項目の入力UIは廃止**（`dim_productivity_manual` の**列・備考 dispatch_other_notes は残す**＝過去値保全）。※「カラム除去」ではない。
- DoD: KPIの総労働時間・残業代・派遣時間が新ソースのみで算出され、旧値と重複しない。（実装済）

## 9. 検証
- 予実（欠勤/計画外出勤の検出）、人件費（時給/月給OT/スポット）、マルチ施設（2施設以上で崩れない）。
- DoD: サンプル月で手計算と一致。
