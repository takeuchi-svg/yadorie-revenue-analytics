-- ============================================================
--  予約日ベース分析 灯の所見（M8）: キャッシュ表 ＋ 灯プロンプト初期投入
--  Supabase SQL Editor で全文 Run（冪等）
--  - ai_booking_insight: 宿×時点(as_of='YYYY-MM')ごとに灯の所見をキャッシュ。書込はAPI(service_role)、閲覧は宿スコープ。
--  - ai_prompt に booking_insight を投入（「灯の頭の中」で編集可。未投入でも defaults.ts が効く）。
--    人格(層1)・会社軸(層2)・宿プロフィール(層3)は buildSystemBlocks が注入。
-- ============================================================

create table if not exists ai_booking_insight (
  facility   TEXT not null references dim_facility(facility),
  as_of      TEXT not null,            -- 'YYYY-MM'（分析時点＝当月）
  content    TEXT not null,
  updated_by TEXT,
  updated_at TIMESTAMPTZ default now(),
  primary key (facility, as_of)
);
alter table ai_booking_insight enable row level security;
drop policy if exists ai_booking_insight_view on ai_booking_insight;
create policy ai_booking_insight_view on ai_booking_insight for select to authenticated
  using (public.can_access_facility(facility));

insert into ai_prompt (prompt_key, content, status, min_role_view, min_role_edit)
values (
  'booking_insight',
  $ak$売上状況を、灯（あなた）が読み解きます。実績とオンハンド（先々の入り）の両面を、予算比・前年比・前年同日比で見て、「いつもと違う動き」に気づき、どのOTA・室数(稼働)か単価かまで下ごしらえします。要因（在庫か料金か）の断定はしません——それは人が決めます。あなたは検知・分解・照合まで。{as_of}時点。

【見る観点】
- 実績（確定した宿泊月）: 売上・OCC・室単価・客単価が、予算比／前年比で目立ってズレた月
- オンハンド（今後の宿泊月）: 現在の入りが、対予算／前年同日比で遅い・速い月やOTA（前年同日＝1年前の同じ日時点の入り）
- 予約日ベース: 施策を打った時期に予約が動いたか（前年同月比）
- 分解: 売上のズレが「室数(稼働)」寄りか「単価」寄りか、どのOTAが主因か
- 照合: その動きに関係しそうな施策（当年／前年同期）

【出力（Markdown・簡潔に。金額は万円・率は%）】
## 実績で気になる点（2〜3個）… 〔いつの宿泊月・指標〕が〔予算比/前年比どれだけ〕。室数／単価どちら寄り
## オンハンドで気になる点（2〜3個）… 〔いつの宿泊月・OTA〕が〔対予算/前年同日比どれだけ〕。入りが遅い／速い
## 施策との照合… 上の動きに関係しそうな施策（当年／前年同期）。無ければ「該当なし」
## 確かめたい問い（2〜3個）… 在庫か料金か等、人が判断するための問い

良い動きも1つは拾う。要因は断定しない。数値は材料の通り正確に、無い数字は作らない。前年同日データが無い月はその旨に留める。内部のテーブル名・列名・英語IDは本文に出さない。$ak$,
  'published', 'owner', 'owner'
)
on conflict (prompt_key) do update set content = excluded.content, status = 'published';

-- 確認: select facility, as_of, length(content) from ai_booking_insight order by as_of desc;
