-- ============================================================
--  AIナレッジ基盤 第2弾 K20 中身の投入（KPI辞書 / 用語集 / 基準PL）
--  Supabase SQL Editor で全文 Run（冪等・ON CONFLICT DO NOTHING）
--
--  重要: すべて status='draft'（未公開）で投入する。
--        → 克樹さんのレビュー前は灯に注入されない（定義誤りの波及防止＝指示書の約束）。
--        管理画面 /knowledge の各タブで内容確認 → note加筆 → 公開、の順で運用。
--
--  前提: ai_knowledge_k20.sql 適用済み（status/draft_content 列と版履歴）。
--        occ_calendar_days は mart_occupancy_calendar.sql 適用済みを想定。
--  再実行安全: 既存キーは上書きしない（克樹さんの編集を保護）。
-- ============================================================

-- ============================================================
--  [1] KPI辞書（提案G・承認①反映。occ2本立て／人件費10科目）
--      note は空（克樹さんが「目線・注意点」を後で加筆）。
--      formula 末尾の (mart_ai: ...) は灯がどの列を読むかの手がかり。
-- ============================================================
insert into kpi_definition (kpi_key, label_ja, formula, numerator, denominator, unit, direction, status, updated_by) values
-- 売上・予約の基本
('revenue','売上（精算額）','C/O確定予約の精算額合計（mart_ai: mart_monthly_kpi.revenue）','精算額(C/O確定)',null,'円','higher_better','draft','system:K20'),
('rooms_sold','室泊数','C/O確定予約の泊数合計（1予約行=1室）','泊数合計(C/O)',null,'室','higher_better','draft','system:K20'),
('guests','人泊数','C/O確定予約の（宿泊人数×泊数）の合計','人数×泊数(C/O)',null,'人','higher_better','draft','system:K20'),
('adr','ADR（室単価）','精算売上 ÷ 室泊数（C/O確定のみ）','精算売上','室泊数','円','higher_better','draft','system:K20'),
('guest_unit','人泊単価（客単価）','精算売上 ÷ 人泊数（C/O確定のみ）','精算売上','人泊数','円','higher_better','draft','system:K20'),
('companion','同伴係数','人泊数 ÷ 室泊数（1室あたり平均宿泊人数）','人泊数','室泊数','倍','higher_better','draft','system:K20'),
-- 稼働率（2本立て：全日ベースを主／稼働日ベースを併存）
('occupancy_rate','稼働率（全日ベース）','販売室数合計 ÷ (客室数 × その月の暦日数)。特記なければ稼働率はこちらを使う（mart_ai: mart_occupancy_monthly.occ_calendar_days）','販売室数合計','客室数 × 暦日数','%','higher_better','draft','system:K20'),
('occupancy_rate_operating','稼働率（稼働日ベース）','販売室数合計 ÷ (客室数 × 稼働日数=売上実績のある日数)。休館日等を除いた実稼働の密度（mart_ai: mart_occupancy_monthly.occ）','販売室数合計','客室数 × 稼働日数','%','higher_better','draft','system:K20'),
('operating_days','稼働日数','その月で売上実績のある日数（販売0の日は非稼働）','売上実績のある日数',null,'日','neutral','draft','system:K20'),
-- キャンセル・リードタイム
('cancel_rate','取消率','キャンセル数 ÷ 全予約数（分母はキャンセルを含む。販売不可・空部屋は除外）（mart_ai: mart_cxl_summary）','キャンセル数','全予約数(ｷｬﾝｾﾙ込)','%','lower_better','draft','system:K20'),
('lead_time','リードタイム','max(チェックイン日 − 予約日, 0)。予約から宿泊までの日数','',null,'日','neutral','draft','system:K20'),
-- 予実・PL
('budget_achievement_rate','予算達成率','実績売上 ÷ 予算売上','実績売上','予算売上','%','higher_better','draft','system:K20'),
('operating_income','営業損益','売上 − 原価 − 販管費 − 人件費（actual_monthly item_code=operating_income）','',null,'円','higher_better','draft','system:K20'),
('gop','GOP（売上総利益）','売上 − 原価','売上 − 原価',null,'円','higher_better','draft','system:K20'),
('cogs_ratio','原価率','売上原価 ÷ 売上','売上原価','売上','%','lower_better','draft','system:K20'),
('sga_ratio','販管費率','販売管理費 ÷ 売上','販売管理費','売上','%','lower_better','draft','system:K20'),
-- 損益分岐点
('cm_ratio','限界利益率','(売上 − 変動費) ÷ 売上','売上 − 変動費','売上','%','higher_better','draft','system:K20'),
('var_ratio','変動費率','変動費 ÷ 売上','変動費','売上','%','lower_better','draft','system:K20'),
('bep_sales','損益分岐点売上高','固定費 ÷ 限界利益率','固定費','限界利益率','円','lower_better','draft','system:K20'),
('bep_ratio','損益分岐点比率','損益分岐点売上高 ÷ 実績売上高（100%未満なら黒字）','損益分岐点売上高','実績売上高','%','lower_better','draft','system:K20'),
-- 生産性・労務
('labor_cost_ratio','売上高人件費率','人件費 ÷ 売上。人件費=給料手当+賞与+通勤費+法定福利費+福利厚生費+雑給+外注費(人材)+外注費(清掃)+外注費(その他)+業務委託料（mart_ai: labor_cost_ratio_monthly）','人件費(上記10科目)','売上','%','lower_better','draft','system:K20'),
('total_work_hours','総労働時間','勤怠の労働分数合計 ÷ 60（HQ除く。mart_ai: mart_labor_monthly）','',null,'h','neutral','draft','system:K20'),
('revenue_per_hour','人時売上（1人1時間あたり売上）','売上 ÷ 総労働時間','売上','総労働時間','円','higher_better','draft','system:K20'),
('value_added_per_hour','人時付加価値','GOP(売上−原価) ÷ 総労働時間','GOP','総労働時間','円','higher_better','draft','system:K20'),
('hours_per_room','1室あたり労働時間','総労働時間 ÷ 室泊数','総労働時間','室泊数','h','lower_better','draft','system:K20'),
('hours_per_guest','顧客1人あたり労働時間','総労働時間 ÷ 人泊数','総労働時間','人泊数','h','lower_better','draft','system:K20'),
('total_overtime_hours','総残業時間','残業分数合計 ÷ 60','',null,'h','lower_better','draft','system:K20'),
('avg_overtime','月給社員1人あたり平均残業時間','総残業時間 ÷ 月給社員数','総残業時間','月給社員数','h','lower_better','draft','system:K20'),
('staff_count','社員数（月給）','正社員のユニーク人数','',null,'名','neutral','draft','system:K20'),
('parttime_count','アルバイト数（時給）','アルバイトのユニーク人数','',null,'名','neutral','draft','system:K20')
on conflict (kpi_key) do nothing;

-- ============================================================
--  [2] 用語集（社内語彙）。note は空。
-- ============================================================
insert into glossary (term, definition_ja, status, updated_by) values
('オンハンド','未チェックインの生きた予約（確定・未確認を含む）の積み上がり状況。予約の入り具合。正データはステイシー予約情報','draft','system:K20'),
('ブッキングペース','将来月のオンハンド売上が予算売上に対しどれくらい積み上がっているか（予約の入りの速さ）','draft','system:K20'),
('同伴係数','人泊数 ÷ 室泊数。1室あたりの平均宿泊人数','draft','system:K20'),
('人泊数','宿泊人数 × 泊数の延べ（guest nights）','draft','system:K20'),
('室泊数','泊数の合計（1室1泊=1、room nights）','draft','system:K20'),
('fiscal_year（年度）','4月〜翌3月。例: 2025年度 = 2025年4月〜2026年3月','draft','system:K20'),
('C/O（チェックアウト）','宿泊が完了し実績が確定した状態。売上・稼働率の集計対象','draft','system:K20'),
('ステイシー','予約管理システム（旧リンカーンから一本化）。予約・取消・オンハンド・リードタイムの正データ源','draft','system:K20'),
('ADR','Average Daily Rate。室単価（1室1泊あたりの売上）','draft','system:K20'),
('GOP','Gross Operating Profit。売上総利益（売上 − 原価）','draft','system:K20'),
('損益分岐点比率','損益分岐点売上高 ÷ 実績売上高。100%未満なら黒字、超なら赤字','draft','system:K20'),
('施設タイプ','基準PL・横断比較の区分。小規模旅館／温泉旅館／小規模都市型ホテル／中規模旅館／都市型ホテル／高級旅館／大規模旅館 の7区分','draft','system:K20')
on conflict (term) do nothing;

-- ============================================================
--  [3] 基準PL（7施設タイプ × 6項目 = 42行）を draft で投入。
--      出所: OKJ_基準PLマスタ(旧_2025ver).xlsx の各タイプ「スタビ(安定化)年」対売上比率。
--      item_key: cogs_ratio=原価率 / labor_cost_ratio=人件費率 / sga_ratio=販管費率
--                / gop_ratio=GOP率 / ebitda_ratio=EBITDA率 / oi_ratio=営業利益率（すべて対売上・ratio）
--      ※稼働率目標・ADR目標はマスタ空欄のため未投入（後日 克樹さんが追加可）。
-- ============================================================
insert into standard_pl_master (facility_type, item_key, value, unit, status, updated_by) values
('小規模旅館','cogs_ratio',0.172,'ratio','draft','system:K20'),
('小規模旅館','labor_cost_ratio',0.294,'ratio','draft','system:K20'),
('小規模旅館','sga_ratio',0.309,'ratio','draft','system:K20'),
('小規模旅館','gop_ratio',0.225,'ratio','draft','system:K20'),
('小規模旅館','ebitda_ratio',0.152,'ratio','draft','system:K20'),
('小規模旅館','oi_ratio',0.134,'ratio','draft','system:K20'),
('温泉旅館','cogs_ratio',0.153,'ratio','draft','system:K20'),
('温泉旅館','labor_cost_ratio',0.290,'ratio','draft','system:K20'),
('温泉旅館','sga_ratio',0.323,'ratio','draft','system:K20'),
('温泉旅館','gop_ratio',0.235,'ratio','draft','system:K20'),
('温泉旅館','ebitda_ratio',0.158,'ratio','draft','system:K20'),
('温泉旅館','oi_ratio',0.139,'ratio','draft','system:K20'),
('小規模都市型ホテル','cogs_ratio',0.049,'ratio','draft','system:K20'),
('小規模都市型ホテル','labor_cost_ratio',0.243,'ratio','draft','system:K20'),
('小規模都市型ホテル','sga_ratio',0.286,'ratio','draft','system:K20'),
('小規模都市型ホテル','gop_ratio',0.422,'ratio','draft','system:K20'),
('小規模都市型ホテル','ebitda_ratio',0.254,'ratio','draft','system:K20'),
('小規模都市型ホテル','oi_ratio',0.234,'ratio','draft','system:K20'),
('中規模旅館','cogs_ratio',0.140,'ratio','draft','system:K20'),
('中規模旅館','labor_cost_ratio',0.279,'ratio','draft','system:K20'),
('中規模旅館','sga_ratio',0.347,'ratio','draft','system:K20'),
('中規模旅館','gop_ratio',0.234,'ratio','draft','system:K20'),
('中規模旅館','ebitda_ratio',0.168,'ratio','draft','system:K20'),
('中規模旅館','oi_ratio',0.149,'ratio','draft','system:K20'),
('都市型ホテル','cogs_ratio',0.039,'ratio','draft','system:K20'),
('都市型ホテル','labor_cost_ratio',0.208,'ratio','draft','system:K20'),
('都市型ホテル','sga_ratio',0.257,'ratio','draft','system:K20'),
('都市型ホテル','gop_ratio',0.496,'ratio','draft','system:K20'),
('都市型ホテル','ebitda_ratio',0.357,'ratio','draft','system:K20'),
('都市型ホテル','oi_ratio',0.338,'ratio','draft','system:K20'),
('高級旅館','cogs_ratio',0.129,'ratio','draft','system:K20'),
('高級旅館','labor_cost_ratio',0.267,'ratio','draft','system:K20'),
('高級旅館','sga_ratio',0.300,'ratio','draft','system:K20'),
('高級旅館','gop_ratio',0.304,'ratio','draft','system:K20'),
('高級旅館','ebitda_ratio',0.227,'ratio','draft','system:K20'),
('高級旅館','oi_ratio',0.179,'ratio','draft','system:K20'),
('大規模旅館','cogs_ratio',0.150,'ratio','draft','system:K20'),
('大規模旅館','labor_cost_ratio',0.303,'ratio','draft','system:K20'),
('大規模旅館','sga_ratio',0.345,'ratio','draft','system:K20'),
('大規模旅館','gop_ratio',0.202,'ratio','draft','system:K20'),
('大規模旅館','ebitda_ratio',0.138,'ratio','draft','system:K20'),
('大規模旅館','oi_ratio',0.111,'ratio','draft','system:K20')
on conflict (facility_type, item_key) do nothing;

-- ---- 動作確認 ----
-- select count(*) from kpi_definition;          -- 30
-- select count(*) from glossary;                -- 12
-- select facility_type, count(*) from standard_pl_master group by facility_type;  -- 各6
-- select kpi_key, status from kpi_definition where status='published';            -- 公開前は0件

-- ---- ロールバック（全ドラフトを消す・克樹さん編集分も消えるので注意） ----
-- delete from kpi_definition     where updated_by='system:K20' and status='draft';
-- delete from glossary           where updated_by='system:K20' and status='draft';
-- delete from standard_pl_master where updated_by='system:K20' and status='draft';
