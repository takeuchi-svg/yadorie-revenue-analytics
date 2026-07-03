-- ============================================================
--  クチコミ・満足度分析 v1  スキーマ（C1）  Supabase SQL Editor で実行（冪等）
--  正本: docs/データベース設計書_クチコミ満足度分析.md
--  読み替え: fact_ → raw_ （本repoの raw_/dim_/mart_ 規約に統一。ユーザー承認済み）
--    fact_review→raw_review / fact_review_summary→raw_review_summary /
--    fact_survey_response→raw_survey_response / fact_feedback_topic→raw_feedback_topic
-- ============================================================

-- ---- 1) raw_review（WEBクチコミ。1行=1クチコミ） ----
create table if not exists raw_review (
  id BIGSERIAL primary key,
  facility TEXT not null references dim_facility(facility),
  source TEXT not null,              -- 'jalan' | 'rakuten' | 'ikyu' | 'google'
  source_review_id TEXT,             -- じゃらん=クチコミ管理番号 / 一休=予約ID / 手動=manual-...
  booking_no TEXT,                   -- 予約番号（raw_reservation.booking_no とJOIN検証対象）
  review_date DATE not null,
  stay_date DATE,
  overall_rating NUMERIC(3,1),
  rating_scale INTEGER not null default 5,
  sub_ratings JSONB,                 -- 項目別評価（キーはソース原文のまま）
  title TEXT,
  body TEXT,
  reviewer_attr JSONB,               -- 性別/年代/シーン/プラン/部屋/価格/post_site 等
  reply_text TEXT,                   -- 将来用（返信管理はスコープ外）
  ingested_via TEXT,                 -- 'api' | 'csv' | 'manual'
  created_at TIMESTAMPTZ default now(),
  unique (facility, source, source_review_id)
);
create index if not exists idx_raw_review_fac_date on raw_review(facility, review_date);
create index if not exists idx_raw_review_booking on raw_review(booking_no);

-- ---- 1b) raw_review_summary（楽天: 宿カルテ集計値の月次転記） ----
create table if not exists raw_review_summary (
  id BIGSERIAL primary key,
  facility TEXT not null references dim_facility(facility),
  source TEXT not null default 'rakuten',
  month TEXT not null,               -- 'YYYY-MM'
  review_count INTEGER,
  overall_avg NUMERIC(3,2),
  axis_scores JSONB,                 -- {"サービス":4.5,"立地":4.2,...}
  area_ranking TEXT,
  created_at TIMESTAMPTZ default now(),
  unique (facility, source, month)
);

-- ---- 2) raw_survey_response（館内アンケート。1行=1回答） ----
create table if not exists raw_survey_response (
  id BIGSERIAL primary key,
  facility TEXT not null references dim_facility(facility),
  response_at TIMESTAMPTZ not null,
  stay_date DATE,
  survey_version TEXT not null,      -- 'v1'
  expectation_gap SMALLINT,
  score_clean SMALLINT,
  score_service SMALLINT,
  score_dinner SMALLINT,
  score_breakfast SMALLINT,
  score_bath SMALLINT,
  low_score_reason TEXT,
  relax_moment SMALLINT,
  most_memorable TEXT,
  most_memorable_other TEXT,
  good_point TEXT,
  improvement_point TEXT,            -- ★改善示唆の主源泉
  nps SMALLINT,
  raw_answers JSONB,
  created_at TIMESTAMPTZ default now()
);
create index if not exists idx_survey_fac_date on raw_survey_response(facility, response_at);

-- ---- 3) dim_survey_question（設問マスタ・バージョン管理） ----
create table if not exists dim_survey_question (
  survey_version TEXT not null,
  question_code TEXT not null,
  question_text TEXT not null,
  question_type TEXT not null,       -- 'scale4'|'scale5'|'nps'|'select'|'free_text'
  axis_code TEXT,
  sort_order INTEGER,
  primary key (survey_version, question_code)
);

-- v1 設問（文言はブランドチーム最終化前の仮。確定時に question_text をUPDATE）
insert into dim_survey_question (survey_version, question_code, question_text, question_type, axis_code, sort_order)
select * from (values
  ('v1','expectation_gap','この宿は、期待と比べてどうでしたか','scale4','expectation_gap',1),
  ('v1','score_clean','清潔感','scale5','clean',2),
  ('v1','score_service','接客','scale5','service',3),
  ('v1','score_dinner','夕食','scale5','dinner',4),
  ('v1','score_breakfast','朝食','scale5','breakfast',5),
  ('v1','score_bath','風呂','scale5','bath',6),
  ('v1','low_score_reason','よろしければ理由をお聞かせください（低評価時）','free_text',null,7),
  ('v1','relax_moment','時間を忘れて過ごせた瞬間はありましたか','scale4','relax',8),
  ('v1','most_memorable','いちばん印象に残ったものは','select','local',9),
  ('v1','good_point','「これは良かった」を1つ','free_text',null,10),
  ('v1','improvement_point','「こうだったらもっと良かった」を1つ','free_text',null,11),
  ('v1','nps','親しい人に薦めたいですか(0-10)','nps',null,12)
) as v(survey_version, question_code, question_text, question_type, axis_code, sort_order)
where not exists (select 1 from dim_survey_question q where q.survey_version='v1' and q.question_code=v.question_code);

-- ---- 4) dim_axis_mapping（評価軸 統一マッピング。実CSVキーに基づく確定版） ----
create table if not exists dim_axis_mapping (
  source TEXT not null,              -- 'jalan'|'rakuten'|'ikyu'|'google'|'survey'
  source_key TEXT not null,          -- sub_ratings のキー（ソース原文）
  axis_code TEXT not null,           -- 統一軸コード
  primary key (source, source_key)
);
insert into dim_axis_mapping (source, source_key, axis_code)
select * from (values
  -- じゃらん（CSV実キー）
  ('jalan','部屋','room'), ('jalan','風呂','bath'),
  ('jalan','料理夕食','dinner'), ('jalan','料理朝食','breakfast'),
  ('jalan','接客・サービス','service'), ('jalan','清潔感','clean'),
  -- 一休（CSV実キー）
  ('ikyu','レイティング(客室・アメニティ)','room'),
  ('ikyu','レイティング(温泉・お風呂)','bath'),
  ('ikyu','レイティング(食事)','meal'),
  ('ikyu','レイティング(接客・サービス)','service'),
  ('ikyu','レイティング(施設・設備)','facility_equip'),
  -- 楽天（宿カルテ集計の軸名。raw_review_summary.axis_scores のキー）
  ('rakuten','サービス','service'), ('rakuten','立地','location'),
  ('rakuten','部屋','room'), ('rakuten','設備・アメニティ','facility_equip'),
  ('rakuten','風呂','bath'), ('rakuten','食事','meal'),
  -- アンケート
  ('survey','score_clean','clean'), ('survey','score_service','service'),
  ('survey','score_dinner','dinner'), ('survey','score_breakfast','breakfast'),
  ('survey','score_bath','bath'), ('survey','relax_moment','relax')
) as v(source, source_key, axis_code)
where not exists (select 1 from dim_axis_mapping m where m.source=v.source and m.source_key=v.source_key);

-- ---- 5) raw_feedback_topic（AI分析結果: トピック×センチメント） ----
create table if not exists raw_feedback_topic (
  id BIGSERIAL primary key,
  facility TEXT not null,
  source_table TEXT not null,        -- 'raw_review' | 'raw_survey_response'
  source_id BIGINT not null,
  source_field TEXT,                 -- 'body'|'good_point'|'improvement_point'|'low_score_reason'
  topic_code TEXT not null,
  topic_label TEXT,
  sentiment TEXT not null,           -- 'positive'|'negative'|'neutral'
  quote TEXT,
  model_version TEXT,
  analyzed_at TIMESTAMPTZ default now(),
  unique (source_table, source_id, source_field, topic_code, model_version)
);
create index if not exists idx_topic_fac on raw_feedback_topic(facility, topic_code, sentiment);

-- ---- RLS（施設スコープ。既存 can_access_facility を使用） ----
do $$
declare t text; pol record;
begin
  foreach t in array array['raw_review','raw_review_summary','raw_survey_response','raw_feedback_topic'] loop
    execute format('alter table %I enable row level security', t);
    for pol in select policyname from pg_policies where schemaname='public' and tablename=t loop
      execute format('drop policy %I on %I', pol.policyname, t);
    end loop;
    execute format(
      'create policy %I on %I for all to authenticated using (public.can_access_facility(facility)) with check (public.can_access_facility(facility))',
      t || '_facility_scope', t);
  end loop;
  -- マスタ: 全員read / adminのみ書き
  foreach t in array array['dim_survey_question','dim_axis_mapping'] loop
    execute format('alter table %I enable row level security', t);
    for pol in select policyname from pg_policies where schemaname='public' and tablename=t loop
      execute format('drop policy %I on %I', pol.policyname, t);
    end loop;
    execute format('create policy %I on %I for select to authenticated using (true)', t || '_read_all', t);
    execute format('create policy %I on %I for insert to authenticated with check (public.is_admin())', t || '_w_i', t);
    execute format('create policy %I on %I for update to authenticated using (public.is_admin()) with check (public.is_admin())', t || '_w_u', t);
    execute format('create policy %I on %I for delete to authenticated using (public.is_admin())', t || '_w_d', t);
  end loop;
end $$;

-- ---- 6) mart_guest_feedback（施設×月×channel×軸。ベイズ平滑化） ----
create or replace view mart_guest_feedback
with (security_invoker = on) as
with review_axis as (
  select f.facility, to_char(f.review_date,'YYYY-MM') as month, 'web' as channel,
         m.axis_code, (kv.value)::numeric * 5.0 / f.rating_scale as score
  from raw_review f
  cross join lateral jsonb_each_text(f.sub_ratings) as kv(key,value)
  join dim_axis_mapping m on m.source = f.source and m.source_key = kv.key
  where kv.value ~ '^[0-9.]+$'
  union all
  select facility, to_char(review_date,'YYYY-MM'), 'web', 'overall',
         overall_rating * 5.0 / rating_scale
  from raw_review where overall_rating is not null
),
survey_axis as (
  select s.facility, to_char(s.response_at,'YYYY-MM') as month, 'survey' as channel,
         a.axis_code, a.score::numeric as score
  from raw_survey_response s
  cross join lateral (values
    ('clean', s.score_clean::numeric), ('service', s.score_service::numeric),
    ('dinner', s.score_dinner::numeric), ('breakfast', s.score_breakfast::numeric),
    ('bath', s.score_bath::numeric),
    ('relax', (s.relax_moment * 5.0 / 4)::numeric)   -- 4段階→5点換算
  ) as a(axis_code, score)
  where a.score is not null
),
unioned as (
  select * from review_axis union all select * from survey_axis
),
monthly as (
  select facility, month, channel, axis_code, count(*) as n, avg(score) as raw_avg
  from unioned group by 1,2,3,4
),
longterm as (  -- 施設×軸の長期平均（直近24ヶ月）= ベイズ事前分布
  select facility, axis_code, avg(score) as lt_avg, count(*) as lt_n
  from unioned
  where month >= to_char(now() - interval '24 months','YYYY-MM')
  group by 1,2
)
select m.facility, m.month, m.channel, m.axis_code, m.n,
       round(m.raw_avg, 2) as raw_avg,
       case when l.lt_n >= 12
            then round((m.n * m.raw_avg + 10 * l.lt_avg) / (m.n + 10), 2)
            else null end as smoothed_avg,
       (m.n < 5) as is_low_sample
from monthly m
left join longterm l using (facility, axis_code);

-- ---- 6b) mart_guest_feedback_3mo（3ヶ月ローリング＝主表示） ----
create or replace view mart_guest_feedback_3mo
with (security_invoker = on) as
with review_axis as (
  select f.facility, date_trunc('month', f.review_date)::date as mdate, 'web' as channel,
         m.axis_code, (kv.value)::numeric * 5.0 / f.rating_scale as score
  from raw_review f
  cross join lateral jsonb_each_text(f.sub_ratings) as kv(key,value)
  join dim_axis_mapping m on m.source = f.source and m.source_key = kv.key
  where kv.value ~ '^[0-9.]+$'
  union all
  select facility, date_trunc('month', review_date)::date, 'web', 'overall',
         overall_rating * 5.0 / rating_scale
  from raw_review where overall_rating is not null
),
survey_axis as (
  select s.facility, date_trunc('month', s.response_at)::date as mdate, 'survey' as channel,
         a.axis_code, a.score::numeric as score
  from raw_survey_response s
  cross join lateral (values
    ('clean', s.score_clean::numeric), ('service', s.score_service::numeric),
    ('dinner', s.score_dinner::numeric), ('breakfast', s.score_breakfast::numeric),
    ('bath', s.score_bath::numeric),
    ('relax', (s.relax_moment * 5.0 / 4)::numeric)
  ) as a(axis_code, score)
  where a.score is not null
),
unioned as (
  select * from review_axis union all select * from survey_axis
),
monthly as (
  select facility, mdate, channel, axis_code, count(*) as n, sum(score) as score_sum
  from unioned group by 1,2,3,4
),
rolled as (  -- 当月＋前2ヶ月
  select a.facility, a.mdate, a.channel, a.axis_code,
         sum(b.n) as n, sum(b.score_sum) / sum(b.n) as raw_avg
  from monthly a
  join monthly b
    on b.facility = a.facility and b.channel = a.channel and b.axis_code = a.axis_code
   and b.mdate between a.mdate - interval '2 months' and a.mdate
  group by 1,2,3,4
),
longterm as (
  select facility, axis_code, avg(score) as lt_avg, count(*) as lt_n
  from unioned
  where mdate >= date_trunc('month', now() - interval '24 months')::date
  group by 1,2
)
select r.facility, to_char(r.mdate,'YYYY-MM') as month, r.channel, r.axis_code, r.n,
       round(r.raw_avg, 2) as raw_avg,
       case when l.lt_n >= 12
            then round((r.n * r.raw_avg + 10 * l.lt_avg) / (r.n + 10), 2)
            else null end as smoothed_avg,
       (r.n < 5) as is_low_sample
from rolled r
left join longterm l using (facility, axis_code);

-- ---- 7) mart_improvement_topics（改善候補TOP集計） ----
create or replace view mart_improvement_topics
with (security_invoker = on) as
select t.facility,
       to_char(coalesce(r.review_date, s.response_at::date),'YYYY-MM') as month,
       t.topic_code, t.topic_label,
       count(*) filter (where t.sentiment = 'negative') as negative_mentions,
       count(*) filter (where t.sentiment = 'positive') as positive_mentions,
       count(distinct t.source_table) as source_kinds,   -- 2=WEB+アンケート両言及（確度高）
       count(distinct t.source_table || ':' || t.source_id) as sources
from raw_feedback_topic t
left join raw_review r on t.source_table = 'raw_review' and t.source_id = r.id
left join raw_survey_response s on t.source_table = 'raw_survey_response' and t.source_id = s.id
group by 1,2,3,4;

-- ---- 8) mart_nps ----
create or replace view mart_nps
with (security_invoker = on) as
select facility, to_char(response_at,'YYYY-MM') as month,
       count(*) as n,
       round(100.0 * (count(*) filter (where nps >= 9) - count(*) filter (where nps <= 6))
             / count(*), 1) as nps_score,
       count(*) filter (where nps >= 9) as promoters,
       count(*) filter (where nps between 7 and 8) as passives,
       count(*) filter (where nps <= 6) as detractors
from raw_survey_response
where nps is not null
group by 1,2;

-- ---- 動作確認（空でもエラーにならないこと） ----
-- select * from mart_guest_feedback limit 5;
-- select * from mart_guest_feedback_3mo limit 5;
-- select * from mart_improvement_topics limit 5;
-- select * from mart_nps limit 5;
