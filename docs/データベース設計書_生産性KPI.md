# 売上分析BI — 生産性KPI機能 データベース設計書

> ⚠️ 更新（as-built）: 本書は設計時案。実装は下記が優先。DB全体の正は [`データベース全体設計.md`](データベース全体設計.md)。
> - **`mart_productivity` ビューは作成していない**。生産性KPIは `productivity` ページでクライアント集計（`mart_labor_monthly`＋`actual_monthly`＋`mart_labor_cost_monthly`）。§5.2/§9のmart_productivity DDLは無効。
> - 既存テーブル名は **`raw_reservation`**（本文の `fact_reservation` は存在しない）、PLは **`actual_monthly`/`budget_monthly`**（`raw_pl_actual` は存在しない。§4.4が正）。
> - 「みなし残業超残業代」「派遣時間」は手入力廃止 → シフト・労務の `mart_labor_cost_monthly` から自動算出（T13）。

**目的**: 生産性KPI管理表（OKJ_2025生産性KPI管理表）をBIツールに実装する  
**前提**: 既存の本番環境（Supabase）に統合。売上分析・PL予実は実装済み  
**スコープ**: 生産性KPI表示のみ（シフト管理は別フェーズ、口コミ点数は対象外）  
**先行施設**: 全施設（勤怠CSVは全施設一括出力のため）

---

## 1. 全体方針

### 既存資産との関係
```
既存（実装済み）:
  fact_reservation     → 売上・客数・販売室数（生産性KPIの分子）
  raw_pl_actual        → PL予実（費目別実績・予算）★追加済み
  dim_facility         → 施設マスタ

今回追加:
  dim_staff            → 従業員マスタ
  raw_attendance_daily → 日次勤怠（労働時間の生データ）★勤怠CSVから
  dim_facility_mapping → 勤怠所属コード↔施設コードの変換表

ビューで自動算出:
  mart_labor_monthly   → 施設×月の労働時間集計
  mart_productivity    → 生産性KPI（1人1時間あたり売上等）
```

### 設計の核心
生産性KPIの計算式は「**分子（売上・GOP・付加価値）÷ 分母（労働時間・人数）**」の形。
- 分子 = 既存の fact_reservation（売上）+ raw_pl_actual（GOP等）から取得
- 分母 = 今回追加の raw_attendance_daily（労働時間）から取得
- 両者を mart_productivity ビューでJOINして動的算出

日次の生データを蓄積することで、月次集計KPIに加え、
将来のシフト予実管理・AIシフト予測の学習データにもなる。

---

## 2. 勤怠CSVの仕様

### ファイル形式
- 拡張子: .xls だが**実体はHTML**（KING OF TIME系出力）
- エンコーディング: UTF-8
- HTMLの `<table>` 構造をパースして取り込む
- **1ファイル = 1日分・全従業員**（845行程度、全施設+本社）
- 月末に1日ずつ出力し、30日分まとめてアップロードする運用

### カラム構成（31列）

| # | カラム | 内容 | 取込 |
|---|--------|------|------|
| 0 | No. | 連番 | 無視 |
| 1 | 所属 | 施設/部門名（コード+名称、ヘルプ含む） | ★施設判定 |
| 2 | 雇用区分 | 正社員/アルバイト等 | ★区分判定 |
| 3 | 名前 | 社員番号+氏名 | ★社員判定 |
| 4-9 | タイムカード/編集/締/スケジュール/時間帯区分/勤務日種別 | 管理情報 | 勤務日種別のみ取込 |
| 10 | 出勤 | 打刻（"FeliCa06/24 09:37..."形式） | 出勤時刻抽出 |
| 11 | 退勤 | 打刻 | 退勤時刻抽出 |
| 12-13 | 休始/休終 | 休憩打刻 | 参考 |
| 14 | 所定 | 所定内労働時間 | ★ |
| 15 | 所定外 | 所定外労働時間 | ★ |
| 16 | 残業 | 残業時間 | ★ |
| 17-19 | 深夜所定/深夜所定外/深夜残業 | 深夜帯 | ★ |
| 20-25 | 休日所定〜休日深夜残業 | 休日労働 | ★ |
| 26 | 遅刻 | | 参考 |
| 27 | 早退 | | 参考 |
| 28 | 休憩 | 休憩時間 | ★ |
| 29 | 労働合計 | 当日総労働時間 | ★最重要 |
| 30 | 備考 | | 参考 |

### パース時の処理
```
所属の判定:
  "102 旅館ぬしや" → コード102を抽出 → dim_facility_mapping で NS に変換
  "1000 運営事業部\nヘルプ111 一久旅館" → ヘルプ勤務
    → 本務は運営事業部(本社)、計上先は111=一久旅館(IK)
    → work_facility（計上先）= IK、home_dept = 本社

雇用区分の判定:
  "1000 正社員" / "1001 正社員（休憩自動計算...）" → 正社員（月給）
  "3001 アルバイト（社保付...）" → アルバイト（時給）

名前の分解:
  "532 池田 真知子" → staff_code=532, name=池田 真知子

時刻の抽出:
  "FeliCa06/24 09:37ヘルプ一久旅館" → 09:37
  "編06/24 08:20" → 08:20
  "C(携帯)06/24 09:27" → 09:27
  "位置06/24 08:23（東京都千...）" → 08:23
  → 正規表現で HH:MM を抽出

労働時間（所定/残業/労働合計等）:
  時:分 or 小数時間の形式 → 分単位の整数に正規化して格納
```

---

## 3. 施設マッピング（勤怠所属コード → BI施設コード）

勤怠CSVの所属コードと、BIの施設コードの対応表。dim_facility_mapping として登録。

| 勤怠コード | 勤怠名称 | BI施設コード |
|-----------|---------|------------|
| 102 | 旅館ぬしや | NS |
| 103 | 旅館岐山 | GZ |
| 104 | 木曽駒高原 森のホテル | MH |
| 105 | 海遊亭 | KT |
| 106 | OQOQ | OQ |
| 107 | 安比高原 森のホテル | AP |
| 108 | 伊豆高原温泉ホテル 森の泉 | MI |
| 110 | つるや旅館 | TR |
| 111 | 一久旅館 | IK |
| 112 | Onn中津川 | ON |
| 113 | Onn湯田温泉 | OY |
| 114 | ゆずり葉 | YZ |
| 115 | 笹屋 | SY |
| 116 | しらはま | SR |
| 117 | かたくりの花 | KR |
| 118 | 玉井館 | TK |
| 119 | baison | BSN |
| 120 | 湯の季 | YNT |
| 121 | 山の手ホテル | FRY |
| 122 | 東屋 | HGY |
| 123 | NOIE | NIE |
| 124 | Onn大曲の花火 | OOH |
| 125 | マリーンホテルはりも | HRM |
| 126 | かじか | KJK |
| 127 | 小谷の湯 | AOY |
| 128 | かめや | KMY |
| 129 | 森本 | MRM |

**本社・管理部門**（施設KPIの対象外、ただし全社労働時間としては集計）:
| 100 | 本社 | HQ |
| 1000 | 運営事業部 | HQ |
| 1001 | 経営企画課 | HQ |
| 1002 | 人事労務課 | HQ |
| 1003 | マーケティング課 | HQ |
| 1004 | 事業開発課 | HQ |
| 1006 | 経理課 | HQ |
| 1007 | 運営管理課 | HQ |
| 1008 | コンサル事業部 | HQ |

**ヘルプ勤務の扱い**: 「{本務部門}\nヘルプ{コード} {施設名}」形式。
労働時間は**計上先施設（ヘルプ先）**に按分する。
例: 運営事業部の人が一久旅館にヘルプ → その時間は IK の労働時間に計上。

---

## 4. テーブル定義（DDL）

### 4.1 dim_facility_mapping（施設マッピング）

```sql
CREATE TABLE dim_facility_mapping (
  attendance_code TEXT PRIMARY KEY,   -- "102"
  attendance_name TEXT,                -- "旅館ぬしや"
  facility TEXT,                        -- "NS"（HQの場合は'HQ'）
  is_facility BOOLEAN DEFAULT TRUE      -- 施設=true, 本社部門=false
);
```

### 4.2 dim_staff（従業員マスタ）

```sql
CREATE TABLE dim_staff (
  staff_code TEXT PRIMARY KEY,         -- "532"
  name TEXT,                            -- "池田 真知子"
  home_facility TEXT,                   -- 本務施設コード（BI施設コード）
  employment_type TEXT,                 -- "正社員" | "アルバイト"
  is_monthly_salary BOOLEAN,            -- 月給=true, 時給=false
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
```

※従業員マスタは勤怠CSV取込時に自動的にupsert（新規社員番号があれば追加）。

### 4.3 raw_attendance_daily（日次勤怠）

```sql
CREATE TABLE raw_attendance_daily (
  id BIGSERIAL PRIMARY KEY,
  staff_code TEXT NOT NULL,
  work_date DATE NOT NULL,
  work_facility TEXT,           -- 計上先施設（ヘルプ先含む。BIコード）
  home_dept TEXT,               -- 本務部門（ヘルプ判定用）
  employment_type TEXT,         -- 正社員/アルバイト
  is_help BOOLEAN DEFAULT FALSE,-- ヘルプ勤務フラグ
  day_type TEXT,                -- 勤務日種別（平日/休日等）
  clock_in TIME,                -- 出勤時刻
  clock_out TIME,               -- 退勤時刻
  -- 労働時間（すべて分単位の整数で格納）
  regular_min INTEGER DEFAULT 0,        -- 所定
  overtime_min INTEGER DEFAULT 0,       -- 所定外
  extra_overtime_min INTEGER DEFAULT 0, -- 残業
  night_regular_min INTEGER DEFAULT 0,  -- 深夜所定
  night_ot_min INTEGER DEFAULT 0,       -- 深夜所定外
  night_extra_min INTEGER DEFAULT 0,    -- 深夜残業
  holiday_regular_min INTEGER DEFAULT 0,-- 休日所定
  holiday_ot_min INTEGER DEFAULT 0,     -- 休日所定外
  holiday_extra_min INTEGER DEFAULT 0,  -- 休日残業
  holiday_night_min INTEGER DEFAULT 0,  -- 休日深夜（合算）
  break_min INTEGER DEFAULT 0,          -- 休憩
  total_work_min INTEGER DEFAULT 0,     -- 労働合計（最重要）
  late_min INTEGER DEFAULT 0,           -- 遅刻
  early_min INTEGER DEFAULT 0,          -- 早退
  source_file TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(staff_code, work_date, work_facility)  -- 同日同施設の重複防止
);

CREATE INDEX idx_att_facility_date ON raw_attendance_daily(work_facility, work_date);
CREATE INDEX idx_att_staff_date ON raw_attendance_daily(staff_code, work_date);
```

**重複排除**: 月末に日次CSVをまとめて入れる際、同じ日を2回入れても
`UNIQUE(staff_code, work_date, work_facility)` でUPSERTして重複しない。

### 4.4 PL予実テーブル ※既存・実DB準拠【確定】

**実際のDB構造（information_schemaで確認済み）:**

PL予実は2テーブルに分かれている（raw_pl_actual ではない）:

```sql
-- 実績（既存）
actual_monthly (
  facility text, fiscal_year text, month text,
  category text,       -- "売上高" | "営業損益金額" | "経常損益金額"
  item_code text,      -- "sales_total", "給料手当", "外注費_人材_" 等
  item_name text,      -- 表示名
  actual numeric,      -- 実績額
  prior_amount numeric -- 昨年額
)

-- 予算（既存）
budget_monthly (
  facility text, fiscal_year text, month text,
  category text, item_code text, item_name text,
  amount numeric,      -- 予算額
  ratio numeric, sort_order integer
)
```

**重要な注意点（freee由来のPL構造）:**

- すべての費目（売上・原価・人件費・販管費）が `category = "売上高"` に入っている
  （会計上の大分類。「人件費」という独立カテゴリは存在しない）
- 利益指標は `category = "営業損益金額"` / `"経常損益金額"`
- **「GOP」という行は存在しない**。代わりに以下を使う:
  - `gross_profit`（売上総損益金額）= 売上 - 原価
  - `operating_income`（営業損益金額）= 営業利益

**人件費の算出（item_codeを個別合算）:**

人件費 = 以下のitem_nameの合計（すべてcategory="売上高"内）:
```
給料手当 + 賞与 + 通勤費 + 法定福利費 + 福利厚生費 
+ 外注費（人材） + 雑給
```

**生産性KPIで参照する主要item:**

| KPI用途 | item_code / item_name | category |
|---------|----------------------|----------|
| 売上高 | sales_total（売上高 計） | 売上高 |
| 人件費 | 給料手当+賞与+通勤費+法定福利費+福利厚生費+外注費（人材） | 売上高 |
| 売上総利益（付加価値近似） | gross_profit（売上総損益金額） | 売上高 |
| 営業利益 | operating_income（営業損益金額） | 営業損益金額 |
| 派遣費（参考） | 外注費_人材_（外注費（人材）） | 売上高 |

**売上の生データ:**
- `raw_reservation`（実装済み・確認済み）から売上・客数・販売室数を取得
- 設計書の他セクションの raw_reservation 参照はそのまま有効

---

## 5. Mart層ビュー（生産性KPI算出）

### 5.1 mart_labor_monthly（労働時間 月次集計）

```sql
CREATE OR REPLACE VIEW mart_labor_monthly AS
SELECT
  work_facility AS facility,
  TO_CHAR(work_date, 'YYYY-MM') AS month,
  -- 人数（その月に1日でも勤務した人をカウント）
  COUNT(DISTINCT staff_code) FILTER (WHERE employment_type = '正社員') AS staff_count_monthly,
  COUNT(DISTINCT staff_code) FILTER (WHERE employment_type = 'アルバイト') AS parttime_count,
  -- 労働時間（分→時間に変換）
  ROUND(SUM(total_work_min) / 60.0, 1) AS total_work_hours,
  ROUND(SUM(total_work_min) FILTER (WHERE NOT is_help) / 60.0, 1) AS own_work_hours,
  ROUND(SUM(total_work_min) FILTER (WHERE is_help) / 60.0, 1) AS help_work_hours,
  -- 残業時間
  ROUND(SUM(overtime_min + extra_overtime_min + night_extra_min 
    + holiday_extra_min) / 60.0, 1) AS total_overtime_hours,
  COUNT(DISTINCT work_date) AS operating_days
FROM raw_attendance_daily
WHERE work_facility != 'HQ'
GROUP BY work_facility, TO_CHAR(work_date, 'YYYY-MM');
```

### 5.2 mart_productivity（生産性KPI）【実DB準拠・確定】

生産性KPI管理表の第4層を再現。売上(raw_reservation)・PL(actual_monthly)・労働時間(mart_labor_monthly)
・手動入力(dim_productivity_manual)をJOIN。

```sql
CREATE OR REPLACE VIEW mart_productivity AS
WITH rev AS (
  -- 売上・客数・販売室数（raw_reservationから）
  SELECT facility, TO_CHAR(checkin, 'YYYY-MM') AS month,
    SUM(revenue_settled) AS revenue,
    SUM(guests_total) AS guests,
    SUM(nights) AS rooms_sold
  FROM raw_reservation
  WHERE status = 'C/O' AND nights > 0
  GROUP BY facility, TO_CHAR(checkin, 'YYYY-MM')
),
pl AS (
  -- 人件費・売上・売上総利益（actual_monthlyから）
  -- 人件費 = 給料手当+賞与+通勤費+法定福利費+福利厚生費+外注費（人材）+雑給
  SELECT facility, month,
    SUM(actual) FILTER (WHERE item_name IN (
      '給料手当','賞与','通勤費','法定福利費','福利厚生費','外注費（人材）','雑給'
    )) AS labor_cost,
    SUM(actual) FILTER (WHERE item_code = 'sales_total') AS pl_revenue,
    SUM(actual) FILTER (WHERE item_code = 'gross_profit') AS gross_profit,
    SUM(actual) FILTER (WHERE item_code = 'operating_income') AS operating_income
  FROM actual_monthly
  GROUP BY facility, month
)
SELECT
  l.facility,
  l.month,
  -- 人数・労働時間
  l.staff_count_monthly,
  l.parttime_count,
  l.total_work_hours,
  l.total_overtime_hours,
  -- 売上高人件費率（PLの人件費 ÷ PLの売上）
  ROUND(pl.labor_cost::NUMERIC / NULLIF(pl.pl_revenue, 0), 4) AS labor_cost_ratio,
  -- 従業員1人1時間あたりの売上（労働生産性）
  ROUND(rev.revenue::NUMERIC / NULLIF(l.total_work_hours, 0)) AS revenue_per_hour,
  -- 従業員1人1時間あたりの付加価値（売上総利益 ÷ 労働時間）
  ROUND(pl.gross_profit::NUMERIC / NULLIF(l.total_work_hours, 0)) AS value_added_per_hour,
  -- 1部屋あたりの労働時間
  ROUND(l.total_work_hours::NUMERIC / NULLIF(rev.rooms_sold, 0), 2) AS hours_per_room,
  -- 顧客1人あたりの労働時間
  ROUND(l.total_work_hours::NUMERIC / NULLIF(rev.guests, 0), 2) AS hours_per_guest,
  -- 月給社員1人あたりの平均残業時間
  ROUND(l.total_overtime_hours::NUMERIC / NULLIF(l.staff_count_monthly, 0), 1) AS avg_overtime_per_staff,
  -- 手動入力指標
  m.deemed_overtime_excess_pay,
  m.dispatch_work_hours
FROM mart_labor_monthly l
LEFT JOIN rev ON l.facility = rev.facility AND l.month = rev.month
LEFT JOIN pl ON l.facility = pl.facility AND l.month = pl.month
LEFT JOIN dim_productivity_manual m ON l.facility = m.facility AND l.month = m.month;
```

**注意:**
- actual_monthly の month の形式（"YYYY-MM" か "4月" か）を実装時に確認し、
  rev側のTO_CHAR形式と一致させること。形式が違う場合は変換が必要。
- 売上は2系統ある: rev.revenue（raw_reservation精算額）と pl.pl_revenue（PL計上額）。
  人件費率はPL同士で揃える（pl_revenue使用）、生産性はraw_reservation使用。
  どちらを正にするか運用で確認。

---

## 6. 生産性KPI一覧（BI表示項目）

生産性KPI管理表の「生産性関連」セクションを完全再現:

| KPI | 計算式 | ソース |
|-----|--------|--------|
| 売上高人件費率 | 人件費 ÷ 売上 | PL + 売上 |
| 社員数（月給社員） | DISTINCT正社員 | 勤怠 |
| アルバイト数（時給社員） | DISTINCTアルバイト | 勤怠 |
| 総労働時間 | SUM(労働合計) | 勤怠 |
| 労働時間（社員/アルバイト） | 雇用区分別SUM | 勤怠 |
| 労働時間（派遣/その他） | 外注費（人材）から | PL |
| 総残業時間 | SUM(残業系) | 勤怠 |
| 月給社員1人あたり平均残業時間 | 総残業 ÷ 社員数 | 勤怠 |
| みなし残業超の残業代 | （別途計算ロジック要確認） | 勤怠+給与 |
| 従業員1人1時間あたりの売上 | 売上 ÷ 総労働時間 | 売上+勤怠 |
| 従業員1人1時間あたりの付加価値 | GOP ÷ 総労働時間 | PL+勤怠 |
| 1部屋あたりの労働時間 | 総労働時間 ÷ 販売室数 | 勤怠+売上 |
| 顧客1人あたりの労働時間 | 総労働時間 ÷ 客数 | 勤怠+売上 |

※「みなし残業超の残業代」は給与計算ロジックが絡むため、初期実装では
勤怠CSVに該当データがあれば取込、なければ後日対応（要確認項目）。

---

## 7. UI（生産性ページ）

サイドバーの「ANALYSIS」グループに「**Productivity（生産性）**」ページを追加。

### 画面構成
1. **KPIカード（上段）**: 売上高人件費率 / 総労働時間 / 1人1時間あたり売上 / 1人1時間あたり付加価値
2. **KPIカード（下段）**: 社員数 / アルバイト数 / 総残業時間 / 1部屋あたり労働時間
3. **月次推移チャート**: 1人1時間あたり売上の推移（bar + line、前年比較）
4. **施設間比較**: 全施設の生産性ランキング（横棒、当月）
5. **労働時間内訳**: 所定/残業/深夜/休日の構成（積み上げ棒）
6. **AIコメンタリー**: 生産性の所見（表示のみ）

データソースバッジ: 「勤怠+PL+売上」を明示。

---

## 8. 取込フロー（Upload画面に追加）

既存のUpload画面に「勤怠CSV取込」を追加。

```
1. 月末に勤怠システムから日次CSV（.xls/HTML形式）を1日ずつ出力
   → 1ヶ月分（約30ファイル）を用意
2. Upload画面の「勤怠取込」エリアに30ファイルまとめてドラッグ&ドロップ
3. ブラウザ内でHTMLパース:
   - 各ファイルから日付を特定（ファイル名 or 打刻日から）
   - 全従業員行をパース
   - 所属→施設マッピング、雇用区分判定、ヘルプ判定
   - 時刻・労働時間を正規化（分単位）
4. raw_attendance_daily にUPSERT（重複日は上書き）
5. dim_staff を自動更新（新規社員番号を追加）
6. mart_productivity ビューが自動的に最新値を反映
```

---

## 9. 実装手順（Claude Code向け）

### Step P1: DBスキーマ追加
- dim_facility_mapping テーブル作成 + 27施設+本社のマッピングをINSERT
- dim_staff テーブル作成
- raw_attendance_daily テーブル作成
- mart_labor_monthly ビュー作成
- mart_productivity ビュー作成（raw_pl_actualの実構造に合わせて調整）

### Step P2: 勤怠CSVパーサー
- HTML形式.xlsのパーサー（/lib/etl/attendance-parser.ts）
- 所属コード抽出 + 施設マッピング
- 雇用区分判定（正社員/アルバイト）
- ヘルプ勤務判定（計上先施設の振り分け）
- 打刻時刻の正規表現抽出
- 労働時間の分単位正規化

### Step P3: 取込API + UI
- /api/upload に勤怠取込エンドポイント追加
- Upload画面に「勤怠CSV取込」セクション追加（複数ファイル対応）
- dim_staff の自動upsert

### Step P4: 生産性ページ
- /app/productivity/page.tsx 作成
- サイドバーに「Productivity」追加
- KPIカード + 月次推移 + 施設間比較 + 労働時間内訳
- mart_productivity からデータ取得

---

## 10. 確定事項（クライアント回答済み）

1. **raw_pl_actual の構造** ✅ 予実管理表（26PL@）が元データと確定。
   費目3階層 + 実績/予算/昨年。GOP・人件費・外注費（人材）を生産性で参照。
   既存実装のカラム名に合わせてmart_productivityのJOINを調整すること。

2. **「みなし残業超の残業代」** ✅ **手動入力**。
   勤怠CSVからは算出せず、設定画面（または専用入力）で月次に手入力する。
   → dim_productivity_manual テーブルに格納（下記4.5）。

3. **労働時間（派遣/その他）** ✅ **手動入力**。
   PLの外注費（人材）とは別に、派遣の労働時間を月次で手入力。
   → dim_productivity_manual テーブルに格納。

4. **本社部門の労働時間** ✅ **スコープに含めない**。
   work_facility = 'HQ' のレコードは生産性KPIの集計から除外（mart_labor_monthlyで除外済み）。

### 4.5 dim_productivity_manual（手動入力指標）【追加】

```sql
CREATE TABLE dim_productivity_manual (
  id SERIAL PRIMARY KEY,
  facility TEXT NOT NULL,
  month TEXT NOT NULL,              -- YYYY-MM
  deemed_overtime_excess_pay INTEGER DEFAULT 0,  -- みなし残業超の残業代
  dispatch_work_hours NUMERIC DEFAULT 0,         -- 派遣・その他の労働時間
  dispatch_other_notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(facility, month)
);
```

設定画面（Settings）に「生産性手動入力」タブを追加し、施設×月で入力する。
mart_productivity ビューはこのテーブルをLEFT JOINして該当値を反映する。

---

*本設計書は生産性KPI機能のスコープを定義する。シフト管理（シフト作成・予実・AI予測）は*
*別フェーズで、本設計の raw_attendance_daily を実績データとして活用する形で接続する。*
*口コミ点数は今回のスコープ外。*
