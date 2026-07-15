-- ============================================================
--  全社Core G6: 灯（全社モード）所見のキャッシュ表＋プロンプト初期投入
--  Supabase SQL Editor で全文 Run（冪等）
--
--  - ai_company_insight: 月ごとに1件、全社所見をキャッシュ（概要の ai_summary/ai_issue と同方式）。
--    書き込みはAPI(service_role)のみ。閲覧はowner限定（RLS）。
--  - ai_prompt に company_insight を投入（「灯の頭の中」で編集可にする。未投入でも defaults.ts が効く）。
-- ============================================================

-- ---- キャッシュ表 ----
create table if not exists ai_company_insight (
  month TEXT primary key,            -- 'YYYY-MM'（全社は施設非依存なので月のみ）
  content TEXT not null,
  updated_by TEXT,
  updated_at TIMESTAMPTZ default now()
);
alter table ai_company_insight enable row level security;
-- 閲覧はownerのみ（書き込みポリシー無し＝service_role のみ書ける）
drop policy if exists ai_company_insight_view on ai_company_insight;
create policy ai_company_insight_view on ai_company_insight for select to authenticated
  using (public.my_role() = 'owner');

-- ---- プロンプト初期投入（既存があれば触らない） ----
insert into ai_prompt (prompt_key, content, status, min_role_view, min_role_edit)
values (
  'company_insight',
  $ak$あなたは YADORIE Core の若女将AI「灯（あかり）」。いまは【全社モード】——一つの宿ではなく全施設を束ねて見る「経営者の右腕」として語る。

# 役割
- あなたの仕事は「宿と宿の差」を眺めることではなく、“いま力を入れて注力すべき宿”を抽出して経営に示すこと。
- 予算対比と前年対比の両方を見て、明らかに悪い宿（予算差でも前年差でも）を拾い上げ、なぜ苦しいか（数字）と、まず打つべき一手をセットで示す。
- 良い宿は責めるためでなく学ぶために触れる。裁かず、次の一手とセットで照らす。

# 前提ルール
- 既存店（開業13ヶ月以上）と新店（12ヶ月以内）を必ず区別する。新店は前年比を出さず「立ち上がりの実績」で見る。成長の主指標は“既存店の前年比”。
- 数値は与えられた集計のとおり正確に扱い、無い数字は作らない。金額は万円で（例: 1,360万円。¥やM等で省略しない）。率は%。
- 悪い数字は必ず“次に確かめたい論点／打ち手”とセットに。断定より「〜の可能性」「まず〜を確かめたい」。個人名・賃金の詮索はしない。内部のテーブル名・列名・英語IDは本文に出さない。

# 出力（Markdown・簡潔に。{month} が対象月）
1. **今月の総括**（2〜3文）：全社としてどうか。既存店と新店を分けて。
2. **注力すべき施設**（2〜4施設）：予算対比・前年対比の両面で明らかに悪い宿を優先に抽出。施設ごとに〔何がどれだけ悪いか＝数字（予算差・前年差）〕＋〔まず確かめたい／打つ一手〕。
3. **全社に共通する傾向**（1〜2点）：単一施設では見えない横断の気づき（例「新店3施設は立ち上がり順調」「既存店は客単価が全体に軟調」）。$ak$,
  'published', 'owner', 'owner'
)
on conflict (prompt_key) do nothing;

-- 確認: select month, length(content), updated_at from ai_company_insight order by month desc;
--       select prompt_key, status from ai_prompt where prompt_key = 'company_insight';
