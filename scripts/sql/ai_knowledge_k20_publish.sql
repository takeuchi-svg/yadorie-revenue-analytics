-- ============================================================
--  K20 ドラフト一括公開（KPI辞書 / 用語集 / 基準PL を draft → published）
--  Supabase SQL Editor で全文 Run。版履歴を残してから公開。
--
--  効果: published になった定義が灯に注入される。
--        → 人件費率の10科目・基準PL（施設タイプ別目標）を灯が正として使えるようになる。
--
--  ※特定の項目だけ下書きに戻したい場合は、公開後に管理画面 /knowledge で個別に調整可。
--  ロールバック: 末尾コメント（status を draft に戻す）。
-- ============================================================

-- KPI辞書: 版履歴 → 公開
insert into kpi_definition_version (kpi_key, content, status, change_note, changed_by)
select kpi_key,
  jsonb_build_object('kpi_key',kpi_key,'label_ja',label_ja,'formula',formula,'numerator',numerator,
                     'denominator',denominator,'unit',unit,'direction',direction,'note',note),
  'published', 'K20一括公開', 'system:K20'
from kpi_definition where status = 'draft';
update kpi_definition set status='published', updated_by='system:K20', updated_at=now() where status='draft';

-- 用語集
insert into glossary_version (term, content, status, change_note, changed_by)
select term, jsonb_build_object('term',term,'definition_ja',definition_ja,'note',note),
  'published', 'K20一括公開', 'system:K20'
from glossary where status = 'draft';
update glossary set status='published', updated_by='system:K20', updated_at=now() where status='draft';

-- 基準PL
insert into standard_pl_master_version (std_id, content, status, change_note, changed_by)
select id, jsonb_build_object('facility_type',facility_type,'item_key',item_key,'value',value,'unit',unit,'note',note),
  'published', 'K20一括公開', 'system:K20'
from standard_pl_master where status = 'draft';
update standard_pl_master set status='published', updated_by='system:K20', updated_at=now() where status='draft';

-- 確認: select status, count(*) from kpi_definition group by status;
--       select status, count(*) from standard_pl_master group by status;

-- ロールバック（全て下書きに戻す）:
-- update kpi_definition     set status='draft' where updated_by='system:K20';
-- update glossary           set status='draft' where updated_by='system:K20';
-- update standard_pl_master set status='draft' where updated_by='system:K20';
