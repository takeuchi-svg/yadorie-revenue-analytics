-- ============================================================
--  予算レビュー（B6）: キャッシュ表 ＋ 灯プロンプト初期投入
--  Supabase SQL Editor で全文 Run（冪等）
--  - ai_budget_review: 宿×年度ごとに灯のレビューをキャッシュ。書き込みはAPI(service_role)のみ、閲覧は宿スコープ。
--  - ai_prompt に budget_review を投入（「灯の頭の中」で編集可。未投入でも defaults.ts が効く）。人格/会社軸/宿プロフィール(基準PL含む)は buildSystemBlocks が注入。
-- ============================================================

create table if not exists ai_budget_review (
  facility    TEXT not null references dim_facility(facility),
  fiscal_year TEXT not null,           -- '2027' 等
  content     TEXT not null,
  updated_by  TEXT,
  updated_at  TIMESTAMPTZ default now(),
  primary key (facility, fiscal_year)
);
alter table ai_budget_review enable row level security;
drop policy if exists ai_budget_review_view on ai_budget_review;
create policy ai_budget_review_view on ai_budget_review for select to authenticated
  using (public.can_access_facility(facility));

insert into ai_prompt (prompt_key, content, status, min_role_view, min_role_edit)
values (
  'budget_review',
  $ak$支配人が作った来期予算を、灯（あなた）がレビューします。灯は「照らす」役で、代わりに作りません。詰問でなく伴走。気づきを“問い”の形で示し、判断は支配人に委ねます。{fy}年度の予算が対象。

【見る観点】
- 前年実績・過去トレンドとの乖離（例「12月の稼働を前年比+15%で置いていますが、根拠を教えていただけますか」）
- 繁閑パターンとの整合（イベント・連休の織り込み漏れ）
- 費目のバランス（人件費率・原価率が前年や同タイプの基準PLと乖離していないか）
- 売上と連動すべき変動費が固定的に置かれていないか
- 宿の意図・取組履歴との整合（例「朝食改善の取組をしていますが、食材原価は前年据置です」）
- 当年度の着地見込との接続（来期の上積みの根拠）

【出力（Markdown・簡潔に。金額は万円・率は%）】
## 全体の印象（2〜3文）
## 気になる点（3〜5個）… 各〔何が・どれだけ〕＋〔確かめたい問い／見直しの提案〕。詰めず前向きに
## 良い点（1〜2個）… 妥当・意欲的な置き方を認める

数値は与えられた材料の通り正確に。無い数字は作らない。個人単位の給与に触れない。内部のテーブル名・列名・英語IDは本文に出さない。$ak$,
  'published', 'owner', 'owner'
)
on conflict (prompt_key) do update set content = excluded.content, status = 'published';

-- 確認: select facility, fiscal_year, length(content) from ai_budget_review order by fiscal_year desc;
