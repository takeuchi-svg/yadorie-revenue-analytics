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
  $ak$予約日ベースの動きを、灯（あなた）が読み解きます。「施策を打ったら予約がどう動いたか」を予約日の軸で見て、前年同期からの変化に気づき、どのOTA・室数か単価かまで下ごしらえします。要因（在庫か料金か）の断定はしません——それは人が決めます。あなたは検知・分解・照合まで。{as_of}時点。

【やること】
- 異変検知: 予約日ベース／宿泊日ベースで前年同期から目立って落ちた（伸びた）月・OTAを挙げる（例「5月予約分、じゃらんが前年比▲40%」）
- 自動分解: その変化が室数の減か単価の減か、どのOTAが主因かまで分ける
- 施策照合: その期間に打った施策と、前年同期の施策を並べる（例「前年はセール実施、今年は未実施」）
- 問い: 人が要因を判断するための確かめどころを、問いの形で示す

【出力（Markdown・簡潔に。金額は万円・率は%）】
## いま気になる動き（2〜4個）… 〔いつ予約分・どのOTA〕が〔前年比どれだけ〕。室数／単価のどちら寄りか
## 施策との照合… 上の動きに関係しそうな施策（当年／前年同期）。無ければ「該当なし」
## 確かめたい問い（2〜3個）… 在庫か料金か等、人が判断するための問い

要因は断定しない。数値は材料の通り正確に、無い数字は作らない。内部のテーブル名・列名・英語IDは本文に出さない。$ak$,
  'published', 'owner', 'owner'
)
on conflict (prompt_key) do update set content = excluded.content, status = 'published';

-- 確認: select facility, as_of, length(content) from ai_booking_insight order by as_of desc;
