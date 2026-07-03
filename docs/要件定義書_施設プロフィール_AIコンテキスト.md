# 施設プロフィール（AIコンテキスト基盤）要件定義書 v1

**対象**: YADORIE売上分析BI への 施設プロフィール + 取組履歴 機能の追加
**目的**: AIエージェントが分析時に参照する「宿ごとの意図・背景」を構造化して蓄積する
**先行施設**: 山の手ホテル(FRY)。初期は本部と施設が共同入力→将来は施設が自走
**前提**: 既存Supabase(raw_/mart_/dim_)・既存Settings画面を踏襲
**併読**: 既存のDB設計群（売上/生産性/クチコミ）と同一DB・別テーブルで統合

---

## 1. 設計思想（最重要）

本機能の役割は「AI分析がぶれないためのコンテキスト供給」。以下の原則を厳守する。

1. **手入力するのは定性・意図のみ**。定量・実態は既存DBを参照する
   （客層/単価実態/繁閑数値/クチコミ傾向は手入力しない。DBが事実を語る）
2. **主観的な成否判定を排除**。取組履歴に「うまくいった」等の主観結果は持たない。
   効果はAIが実績DB(mart_guest_feedback/mart_monthly_kpi等)と突合して客観判定する
3. **意図と事実を分離**。プロフィール=意図/方針、実績DB=事実。
   AIは両方を読み「狙いと実態のギャップ」を発見できる
4. **アンカーを作らない**。支配人の先入観になる情報（褒められやすい点等）は載せない
5. **静的情報(上書き)と時系列情報(蓄積)を別テーブルに**分ける

---

## 2. テーブル設計

### 2.1 dim_facility_profile（施設プロフィール：静的・上書き）

1施設=1行。設定画面で編集・更新（上書き保存）。全て定性テキスト。

```sql
CREATE TABLE dim_facility_profile (
  facility TEXT PRIMARY KEY REFERENCES dim_facility(facility),

  -- 基本情報（事実・静的）
  location_context TEXT,       -- 所在地/エリア特性/周辺観光/アクセス
  history TEXT,                -- 開業年・改装歴
  room_composition TEXT,       -- 客室数・タイプ構成
  onsen_spec TEXT,             -- 泉質・源泉かけ流し有無
  location_type TEXT,          -- 立地区分(駅前/温泉街/リゾート/秘湯 等)
  price_min INTEGER,           -- 最低価格帯(1泊2食)
  price_max INTEGER,           -- 最高ランク(1泊2食)

  -- ブランド・コンセプト（意図）
  core_value TEXT,             -- 中核価値
  emotional_value TEXT,        -- 情緒価値
  functional_value TEXT,       -- 機能価値
  brand_concept TEXT,          -- ブランドコンセプト
  target_experience TEXT,      -- 提供したい顧客体験
  target_customer TEXT,        -- ブランド上のターゲット顧客(意図)
  differentiation TEXT,        -- 差別化ポイント

  -- サービス・体験の実態（事実・箇条書き想定）
  services TEXT,               -- 主なサービス内容
  dining_feature TEXT,         -- 食事のコンセプトと特徴(名物含む)
  room_feature TEXT,           -- 部屋の特徴
  bath_feature TEXT,           -- 風呂の特徴
  hospitality_policy TEXT,     -- 接客方針・おもてなしの特徴
  facility_amenity TEXT,       -- 館内施設・アメニティの特色

  -- 運営者の視点（意図）
  management_policy TEXT,      -- 支配人の運営方針・こだわり
  ng_items TEXT,               -- 避けたいこと・NG（★全施設必須）
  seasonal_policy TEXT,        -- 季節ごとの取組方針
  competitors TEXT,            -- 競合施設（★全施設必須）

  updated_at TIMESTAMPTZ DEFAULT now(),
  updated_by TEXT
);
```

**手入力しない（DB参照に置換した）項目**:
| 廃止項目 | 参照先 |
|---|---|
| 想定客層(実態) | raw_reservation（居住地/属性） |
| 価格実態 | mart_monthly_kpi（ADR/客単価） |
| 褒められ/指摘されやすい点 | mart_guest_feedback（かつアンカー防止で意図的に不採用） |
| 繁忙期の数値パターン | mart_occupancy_monthly |

### 2.2 raw_seasonality_note（繁閑理由：月次・蓄積）

繁閑の「数値」はDBが持つ。ここには「なぜその月が忙しい/暇か」の**理由**を月次で持つ。

```sql
CREATE TABLE raw_seasonality_note (
  id BIGSERIAL PRIMARY KEY,
  facility TEXT NOT NULL REFERENCES dim_facility(facility),
  month INTEGER NOT NULL,       -- 1〜12（暦月。年をまたいで共通の季節性）
  note TEXT,                    -- 繁閑の理由（例:2月=河津桜まつりで急増）
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (facility, month)
);
```

**設計判断**: 繁閑の理由は「毎年2月は桜で混む」のように暦月に紐づく季節性なので、
年ではなく1〜12の暦月で持つ（12行/施設）。特定年の特殊事情は取組履歴で記録。

### 2.3 raw_facility_initiative（取組履歴：時系列・蓄積）

1取組=1行。トライ&エラーの記録。**主観的結果カラムは持たない**。
効果判定はAIが実績DBと突合して客観的に行う。

```sql
CREATE TABLE raw_facility_initiative (
  id BIGSERIAL PRIMARY KEY,
  facility TEXT NOT NULL REFERENCES dim_facility(facility),
  year_month TEXT NOT NULL,     -- 'YYYY-MM'（取組を実施/記録した月）
  category TEXT,                -- 食事/接客/集客/設備/価格/オペレーション 等
  title TEXT NOT NULL,          -- 取組の見出し
  description TEXT,             -- 何をやったかの事実（100-200字）
  status TEXT DEFAULT '実行',   -- 計画/実行/完了
  created_at TIMESTAMPTZ DEFAULT now(),
  created_by TEXT
);
CREATE INDEX idx_initiative_fac_month ON raw_facility_initiative(facility, year_month);
```

**AI因果検証の例**: 「2026-03 に朝食品数を増やした」(initiative) を、
mart_guest_feedback の朝食軸スコア推移とJOINし、AIが効果を客観判定する。
outcome を手入力させないことが、この客観性の担保になる。

---

## 3. 設定画面仕様（Settings に「施設プロフィール」タブ追加）

### 3.1 画面構成

```
[施設プロフィール] タブ
 ├ セクション別アコーディオン（基本情報/ブランド/サービス体験/運営者視点）
 │   各項目: ラベル + テキスト + [編集]ボタン + 具体性ゲージ
 ├ [繁閑理由] サブセクション: 1〜12月の月次メモ（12行のインライン編集）
 └ [取組履歴] サブセクション:
     ├ 当月未記入アラート（赤バッジ「{YYYY-MM}の取組が未記録」）
     ├ [＋今月の取組を追加] ボタン
     └ 時系列リスト（月降順、category色分け）
```

### 3.2 編集・保存
- プロフィール(dim_facility_profile): 項目単位 or セクション単位で編集→上書き保存
- 繁閑理由: 月ごとにインライン編集→upsert
- 取組履歴: 追記のみ（編集は当月分のみ許可、過去は不変）
- updated_by/created_by に編集者を記録

### 3.3 具体性ゲージ（★特徴的要件）

各定性項目の入力欄に、パスワード強度風の「具体性ゲージ」を表示。

**R1（ルールベース・即時判定）**:
```
スコア加点要素:
  文字数（〜適正長。長すぎ/短すぎは減点）
  固有名詞・具体語の含有（料理名/設備名/地名など。辞書 or 数字/カタカナ比率）
  数値の含有（品数/時間/距離など）
判定表示:
  赤(抽象的) → 黄 → 緑(具体的) の3〜4段階カラーゲージ
  プレースホルダーに良い記入例を表示
    例(食事): 「地元の金目鯛の煮付けが名物。朝食は焼きたての干物とだし巻き」
    悪い例:   「こだわりの料理を提供」→ 赤
```

**R2（AI判定・保存時フィードバック）**:
- 保存時にAIが具体性を評価し、改善サジェスト
  （「"こだわり"より具体的な料理名を入れると分析精度が上がります」）

### 3.4 未記入督促
- 取組履歴が当月未記入の施設に、設定画面トップとダッシュボードにアラート表示
- 月次会議とセットの運用を想定（会議後に記録）
- 強制はしないが、抜けを可視化

### 3.5 権限（段階運用）
- R1: 本部と施設が共同編集（初期構築。権限は緩く全項目編集可）
- R2: 施設が自走。施設ユーザーは自施設のみ編集可（将来のRLS設計に接続）

---

## 4. AIエージェント連携（想定）

将来のAI分析エージェントは、1施設の分析時に以下を**まとめて読む**:
```
dim_facility_profile     … 宿の意図・方針・NG・競合
raw_seasonality_note     … 繁閑の背景
raw_facility_initiative  … 実施した施策の履歴（事実）
＋
mart_monthly_kpi / mart_guest_feedback / mart_productivity … 実績（事実）
```
これにより「意図(プロフィール) vs 実態(実績)」のギャップ分析、
「施策(initiative) → 効果(実績推移)」の因果検証、
「NGに反しない改善提案」が可能になる。
※本要件ではデータ基盤の整備までを対象とし、エージェント実装は別フェーズ。

---

## 5. 実装ステップ（Claude Code）

### F1: DBスキーマ
- dim_facility_profile / raw_seasonality_note / raw_facility_initiative のDDL投入
- FRYの空レコード初期化（12ヶ月の繁閑行含む）
- 受入: 空でもエラーなく、設定画面から読み書きできる

### F2: 設定画面「施設プロフィール」タブ
- セクション別アコーディオン + 項目編集 + 上書き保存
- 繁閑理由の月次インライン編集
- 取組履歴の追加・時系列表示・当月未記入アラート
- 受入: FRYで全項目入力・保存・再表示できる

### F3: 具体性ゲージ（R1ルールベース）
- 各定性項目に即時判定カラーゲージ + 良い記入例プレースホルダー
- 受入: 抽象的入力=赤、具体的入力=緑になる

### F4: 督促・権限（R1範囲）
- 当月取組未記入アラート（設定トップ+ダッシュボード）
- 共同編集で運用開始（施設別RLSはR2）

### F5（R2）: AI具体性判定 + 施設自走権限
- 保存時AIフィードバック、施設ユーザーの自施設限定編集(RLS)

---

## 6. 受け入れ基準

- [ ] 手入力項目が定性・意図のみで、定量/実態の手入力欄が存在しない
- [ ] 取組履歴に主観的成否(outcome)カラムが存在しない
- [ ] 繁閑理由が月次(1-12)で入力できる
- [ ] 取組履歴が月次で蓄積され、当月未記入がアラートされる
- [ ] NG・競合が全施設必須項目として扱われる
- [ ] 具体性ゲージが入力の具体度で色変化する
- [ ] 初期は共同編集、将来は施設自走(RLS)に拡張できる構造
- [ ] 既存の売上/生産性/クチコミ機能に影響しない
- [ ] AIが profile + 実績DB を横断参照できる（同一DB・facility結合）

---

## 7. 未確定事項
1. 具体性ゲージの具体語辞書の初期セット（F3実装時に調整）
2. 施設自走時のRLS詳細（R2で既存認証設計と統合）
3. 取組履歴 category の確定リスト（運用開始後に会議カテゴリと整合）
