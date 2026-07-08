// 施設プロフィールの項目定義と具体性ゲージ（R1ルールベース）
// 正本: docs/要件定義書_施設プロフィール_AIコンテキスト.md §2.1 / §3.3

export interface ProfileField {
  key: string
  label: string
  placeholder: string   // 良い記入例
  required?: boolean    // ★全施設必須（ng_items / competitors）
  rows?: number
}
export interface ProfileSection { title: string; note?: string; fields: ProfileField[] }

export const PROFILE_SECTIONS: ProfileSection[] = [
  {
    title: '基本情報（事実・静的）',
    fields: [
      { key: 'location_context', label: '所在地・エリア特性・周辺観光・アクセス', placeholder: '例: 河津駅から徒歩8分。2月は河津桜まつりで町全体が混雑。近隣に踊り子温泉会館、天城峠まで車30分', rows: 2 },
      { key: 'history', label: '開業年・改装歴', placeholder: '例: 1972年開業。2019年に大浴場と露天風呂を改装、2023年に客室4室をリニューアル' },
      { key: 'room_composition', label: '客室数・タイプ構成', placeholder: '例: 全16室。和室10・和洋室4・露天風呂付き特別室2' },
      { key: 'onsen_spec', label: '泉質・源泉', placeholder: '例: ナトリウム塩化物泉、源泉かけ流し（加水なし）。飲泉可' },
      { key: 'location_type', label: '立地区分', placeholder: '例: 温泉街（駅前/温泉街/リゾート/秘湯 等）' },
    ],
  },
  {
    title: 'ブランド・コンセプト（意図）',
    fields: [
      { key: 'core_value', label: '中核価値', placeholder: '例: 河津桜と海の幸を、静けさの中で味わえる大人の湯宿', rows: 2 },
      { key: 'emotional_value', label: '情緒価値', placeholder: '例: 波音を聞きながら露天に浸かる時間の解放感。仲居との肩肘張らない会話' },
      { key: 'functional_value', label: '機能価値', placeholder: '例: 全室オーシャンビュー。夕食は部屋出し対応。駅送迎あり' },
      { key: 'brand_concept', label: 'ブランドコンセプト', placeholder: '例: 「海と桜の間で、なにもしない贅沢を」' },
      { key: 'target_experience', label: '提供したい顧客体験', placeholder: '例: チェックインから夕食まで時計を見ない滞在。連泊時は献立を全替えして飽きさせない', rows: 2 },
      { key: 'target_customer', label: 'ターゲット顧客（ブランド上の意図）', placeholder: '例: 50-60代の夫婦。記念日利用。静かに過ごしたい一人旅' },
      { key: 'differentiation', label: '差別化ポイント', placeholder: '例: 金目鯛の姿煮は創業以来の名物で提供数は町内最多。貸切露天が3つあり待ちが発生しない', rows: 2 },
    ],
  },
  {
    title: 'サービス・体験の実態（事実）',
    fields: [
      { key: 'services', label: '主なサービス内容', placeholder: '例: 駅送迎（15時-18時）、湯上がりビールサービス、夜食おにぎり処（21-22時）', rows: 2 },
      { key: 'dining_feature', label: '食事のコンセプトと特徴（名物含む）', placeholder: '例: 地元の金目鯛の煮付けが名物。朝食は焼きたての干物とだし巻き。米は棚田米を釜炊き', rows: 2 },
      { key: 'room_feature', label: '部屋の特徴', placeholder: '例: 全室から海が見える。特別室2室は源泉引きの陶器露天付き。Wi-Fiは全室光回線' },
      { key: 'bath_feature', label: '風呂の特徴', placeholder: '例: 大浴場+露天+貸切3。夜通し入浴可。大浴場は2019年改装だが脱衣所は未改装' },
      { key: 'hospitality_policy', label: '接客方針・おもてなしの特徴', placeholder: '例: 過干渉にしない距離感を重視。夕食の説明は1品30秒以内。名前でお呼びする' },
      { key: 'facility_amenity', label: '館内施設・アメニティの特色', placeholder: '例: ロビーに桜葉茶の無料サービス。選べる浴衣（女性5色）。アメニティは雪肌精' },
    ],
  },
  {
    title: '運営者の視点（意図）',
    note: '★「避けたいこと・NG」「競合施設」は全施設必須です（AIの提案がブランドを壊さないための制約になります）',
    fields: [
      { key: 'management_policy', label: '支配人の運営方針・こだわり', placeholder: '例: 稼働率より客単価と連泊率を重視。清掃は外注せず自社スタッフで品質管理', rows: 2 },
      { key: 'ng_items', label: '避けたいこと・NG（★必須）', placeholder: '例: 大型団体の受け入れ。廊下での大声案内。過度な値引き販売（ブランド毀損）', required: true, rows: 2 },
      { key: 'seasonal_policy', label: '季節ごとの取組方針', placeholder: '例: 2月の桜まつりは料金を強気に設定し連泊限定プランを主力に。夏は家族客も許容', rows: 2 },
      { key: 'competitors', label: '競合施設（★必須）', placeholder: '例: 玉峰館（河津・高級路線）、今井荘（稲取・海側）、おくど（同価格帯で食事推し）', required: true, rows: 2 },
    ],
  },
]

export const INITIATIVE_CATEGORIES = ['食事', '接客', '集客', '設備', '価格', 'オペレーション', 'その他'] as const

// 施設タイプ（基準PL・横断比較の区分。standard_pl_master.facility_type と一致させる）
export const FACILITY_TYPES = ['小規模旅館', '温泉旅館', '小規模都市型ホテル', '中規模旅館', '都市型ホテル', '高級旅館', '大規模旅館'] as const

// ---- 具体性ゲージ（R1: ルールベース即時判定） ----
// 0=抽象的(赤) 1=やや抽象(橙) 2=やや具体(黄) 3=具体的(緑)
const ABSTRACT_WORDS = /(こだわり|おもてなし|心を込め|真心|最高|素晴らし|様々|さまざま|いろいろ|色々|充実|豊富|アットホーム|くつろぎの空間|癒やし|癒し)/g

export function concreteness(text: string): { score: 0 | 1 | 2 | 3; label: string } {
  const t = (text ?? '').trim()
  if (t.length < 10) return { score: 0, label: t.length === 0 ? '未入力' : '短すぎ' }
  let s = 0
  if (t.length >= 30 && t.length <= 400) s += 1              // 適正長
  if (/\d/.test(t)) s += 1                                    // 数値（品数/時間/年 等）
  if (/[ァ-ヴー]{3,}/.test(t) || /[「」・、]/.test(t)) s += 1  // 固有名詞らしさ/列挙
  const abstractHits = (t.match(ABSTRACT_WORDS) ?? []).length
  s -= Math.min(2, abstractHits)                              // 抽象語ペナルティ
  const score = Math.max(0, Math.min(3, s)) as 0 | 1 | 2 | 3
  return { score, label: ['抽象的', 'やや抽象的', 'やや具体的', '具体的'][score] }
}

export const GAUGE_COLORS = ['var(--red)', '#BA7517', '#c9a227', 'var(--green)']
