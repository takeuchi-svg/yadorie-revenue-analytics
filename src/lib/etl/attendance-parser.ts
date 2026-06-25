// 勤怠CSV（Touch On Time / 拡張子.xls・実体HTML・UTF-8）パーサー
// HTMLテーブルを「ヘッダー名アンカー方式」で解析（列構成の差異に強い）。
//  - 全施設出力: 「所属」列あり（31列）。施設は所属コードから（ヘルプ按分対応）
//  - 単一施設出力: 「所属」列なし（30列・全体が1つずれる）。施設はタイトル「従業員：○○」から名前判定
// 施設コードの変換はこの定数を正とする（scripts/sql/productivity.sql の seed と一致させること）。

export interface AttendanceInsert {
  staff_code: string
  work_date: string // 'YYYY-MM-DD'
  work_facility: string | null
  home_dept: string | null
  employment_type: string // '正社員' | 'アルバイト'
  is_help: boolean
  day_type: string | null
  clock_in: string | null // 'HH:MM'
  clock_out: string | null
  regular_min: number
  overtime_min: number
  extra_overtime_min: number
  night_regular_min: number
  night_ot_min: number
  night_extra_min: number
  holiday_regular_min: number
  holiday_ot_min: number
  holiday_extra_min: number
  holiday_night_min: number
  break_min: number
  total_work_min: number
  late_min: number
  early_min: number
  source_file: string
}

export interface StaffInsert {
  staff_code: string
  name: string
  home_facility: string | null
  employment_type: string
  is_monthly_salary: boolean
}

export interface AttendanceParseResult {
  workDate: string
  rows: AttendanceInsert[]
  staff: StaffInsert[]
  totalRows: number
  facilityMode: 'per-row' | 'single' // 施設判定方式（参考）
  facilityName: string | null        // 単一施設出力で検出した施設名
}

// 勤怠所属コード → BI施設コード（本社部門は 'HQ'）
const FACILITY_MAP: Record<string, string> = {
  '102': 'NS', '103': 'GZ', '104': 'MH', '105': 'KT', '106': 'OQ', '107': 'AP',
  '108': 'MI', '110': 'TR', '111': 'IK', '112': 'ON', '113': 'OY', '114': 'YZ',
  '115': 'SY', '116': 'SR', '117': 'KR', '118': 'TK', '119': 'BSN', '120': 'YNT',
  '121': 'FRY', '122': 'HGY', '123': 'NIE', '124': 'OOH', '125': 'HRM', '126': 'KJK',
  '127': 'AOY', '128': 'KMY', '129': 'MRM',
  '100': 'HQ', '1000': 'HQ', '1001': 'HQ', '1002': 'HQ', '1003': 'HQ',
  '1004': 'HQ', '1006': 'HQ', '1007': 'HQ', '1008': 'HQ',
}

// 施設名 → BI施設コード（単一施設出力のタイトル判定用。空白は無視して比較）
const NAME_FAC: [string, string][] = [
  ['旅館ぬしや', 'NS'], ['旅館岐山', 'GZ'], ['木曽駒高原森のホテル', 'MH'], ['海遊亭', 'KT'],
  ['OQOQ', 'OQ'], ['安比高原森のホテル', 'AP'], ['伊豆高原温泉ホテル森の泉', 'MI'], ['つるや旅館', 'TR'],
  ['一久旅館', 'IK'], ['Onn中津川', 'ON'], ['Onn湯田温泉', 'OY'], ['ゆずり葉', 'YZ'], ['笹屋', 'SY'],
  ['しらはま', 'SR'], ['かたくりの花', 'KR'], ['玉井館', 'TK'], ['baison', 'BSN'], ['湯の季', 'YNT'],
  ['山の手ホテル', 'FRY'], ['東屋', 'HGY'], ['NOIE', 'NIE'], ['Onn大曲の花火', 'OOH'],
  ['マリーンホテルはりも', 'HRM'], ['かじか', 'KJK'], ['小谷の湯', 'AOY'], ['かめや', 'KMY'], ['森本', 'MRM'],
]

const norm = (s: string) => s.replace(/ /g, ' ').replace(/\s+/g, '').trim()
const leadingCode = (s: string): string | null => { const m = s.trim().match(/^(\d+)/); return m ? m[1] : null }

const toMin = (raw: string): number => {
  const s = raw.replace(/\s+/g, '').trim()
  if (!s || s === '-') return 0
  if (s.includes(':')) { const [h, m] = s.split(':'); return Math.round((Number(h) || 0) * 60 + (Number(m) || 0)) }
  const v = parseFloat(s)
  return isNaN(v) ? 0 : Math.round(v * 60)
}

const parsePunch = (s: string): { mm: number; dd: number; hhmm: string } | null => {
  const m = s.match(/(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2})/)
  if (!m) return null
  return { mm: Number(m[1]), dd: Number(m[2]), hhmm: `${m[3].padStart(2, '0')}:${m[4]}` }
}

const cellText = (td: Element): string => (td.textContent ?? '').replace(/ /g, ' ').replace(/\s+/g, ' ').trim()
const empType = (s: string): { type: string; monthly: boolean } =>
  /アルバイト|パート/.test(s) ? { type: 'アルバイト', monthly: false } : { type: '正社員', monthly: true }

const fileDate = (name: string): { y: number; mo: number; d: number } | null => {
  const m = name.match(/(\d{4})(\d{2})(\d{2})\d{0,6}/)
  return m ? { y: +m[1], mo: +m[2], d: +m[3] } : null
}

// タイトル（表より前）から施設名→BIコードを判定
const facilityFromTitle = (html: string): { fac: string | null; name: string | null } => {
  const ti = html.search(/<table/i)
  const pre = (ti > 0 ? html.slice(0, ti) : html).replace(/<[^>]+>/g, ' ')
  const text = norm(pre)
  let bestFac: string | null = null, bestName: string | null = null, bestLen = 0
  for (const [nm, fac] of NAME_FAC) {
    const key = norm(nm)
    if (text.includes(key) && key.length > bestLen) { bestFac = fac; bestName = nm; bestLen = key.length }
  }
  return { fac: bestFac, name: bestName }
}

export function parseAttendanceHtml(html: string, fileName: string): AttendanceParseResult {
  const doc = new DOMParser().parseFromString(html, 'text/html')

  // ---- ヘッダーを認識して列インデックスを特定 ----
  const ths = Array.from(doc.querySelectorAll('th'))
  const col: Record<string, number> = {}
  ths.forEach((th, i) => { const k = norm(cellText(th)); if (k && !(k in col)) col[k] = i })
  const ix = (k: string) => (k in col ? col[k] : -1)
  const iName = ix('名前'), iEmp = ix('雇用区分'), iTotal = ix('労働合計'), iSosoku = ix('所属')
  if (iName < 0 || iEmp < 0 || iTotal < 0) {
    throw new Error('勤怠ヘッダーを認識できません（名前/雇用区分/労働合計が見つかりません）')
  }
  const iIn = ix('出勤'), iOut = ix('退勤'), iDay = ix('勤務日種別')
  const iReg = ix('所定'), iOt = ix('所定外'), iExtra = ix('残業')
  const iNReg = ix('深夜所定'), iNOt = ix('深夜所定外'), iNEx = ix('深夜残業')
  const iHReg = ix('休日所定'), iHOt = ix('休日所定外'), iHEx = ix('休日残業')
  const iHN1 = ix('休日深夜所定'), iHN2 = ix('休日深夜所定外'), iHN3 = ix('休日深夜残業')
  const iLate = ix('遅刻'), iEarly = ix('早退'), iBreak = ix('休憩')

  // 単一施設出力（所属列なし）はタイトルから施設を決定
  const perRow = iSosoku >= 0
  const title = perRow ? { fac: null as string | null, name: null as string | null } : facilityFromTitle(html)
  if (!perRow && !title.fac) {
    throw new Error('施設を特定できません（単一施設出力のタイトルから施設名を読み取れませんでした）')
  }

  const fd = fileDate(fileName)
  const at = (cells: string[], i: number) => (i >= 0 && i < cells.length ? cells[i] : '')

  type Parsed = {
    staffCode: string; name: string; emp: { type: string; monthly: boolean }
    workFacility: string | null; homeDept: string | null; isHelp: boolean
    dayType: string | null; clockIn: string | null; clockOut: string | null; mins: number[]
  }
  const parsed: Parsed[] = []
  const dateVotes = new Map<string, number>()

  for (const tr of Array.from(doc.querySelectorAll('tr'))) {
    const tds = Array.from(tr.querySelectorAll('td'))
    if (tds.length <= iTotal) continue
    const c = tds.map(cellText)
    const staffCode = leadingCode(at(c, iName))
    if (!staffCode) continue

    const name = at(c, iName).replace(/^\d+\s*/, '').trim()
    const emp = empType(at(c, iEmp))

    let workFacility: string | null, homeDept: string | null, isHelp = false
    if (perRow) {
      const so = at(c, iSosoku)
      if (so.includes('ヘルプ')) {
        const [homePart, helpPart] = so.split('ヘルプ')
        homeDept = (leadingCode(homePart) && FACILITY_MAP[leadingCode(homePart)!]) || null
        workFacility = (leadingCode(helpPart ?? '') && FACILITY_MAP[leadingCode(helpPart ?? '')!]) || null
        isHelp = true
      } else {
        const code = leadingCode(so)
        workFacility = code ? FACILITY_MAP[code] ?? null : null
        homeDept = workFacility
      }
    } else {
      workFacility = title.fac
      homeDept = title.fac
    }

    const inP = parsePunch(at(c, iIn)); const outP = parsePunch(at(c, iOut))
    if (inP) dateVotes.set(`${inP.mm}-${inP.dd}`, (dateVotes.get(`${inP.mm}-${inP.dd}`) ?? 0) + 1)

    parsed.push({
      staffCode, name, emp, workFacility, homeDept, isHelp,
      dayType: at(c, iDay) || null, clockIn: inP?.hhmm ?? null, clockOut: outP?.hhmm ?? null,
      mins: [
        toMin(at(c, iReg)), toMin(at(c, iOt)), toMin(at(c, iExtra)),
        toMin(at(c, iNReg)), toMin(at(c, iNOt)), toMin(at(c, iNEx)),
        toMin(at(c, iHReg)), toMin(at(c, iHOt)), toMin(at(c, iHEx)),
        toMin(at(c, iHN1)) + toMin(at(c, iHN2)) + toMin(at(c, iHN3)),
        toMin(at(c, iBreak)), toMin(at(c, iTotal)),
        toMin(at(c, iLate)), toMin(at(c, iEarly)),
      ],
    })
  }

  // 勤務日 = 出勤打刻日の最頻値（年はファイル名から。越年のみ補正）
  let mm = fd?.mo ?? 1, dd = fd?.d ?? 1, best = -1
  for (const [k, v] of dateVotes) if (v > best) { best = v;[mm, dd] = k.split('-').map(Number) }
  let year = fd?.y ?? new Date().getFullYear()
  if (fd && mm === 12 && fd.mo === 1) year -= 1
  const workDate = `${year}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`

  const agg = new Map<string, AttendanceInsert>()
  const staffMap = new Map<string, StaffInsert>()
  for (const p of parsed) {
    if (!staffMap.has(p.staffCode)) {
      staffMap.set(p.staffCode, { staff_code: p.staffCode, name: p.name, home_facility: p.homeDept, employment_type: p.emp.type, is_monthly_salary: p.emp.monthly })
    }
    const key = `${p.staffCode}|${p.workFacility ?? ''}`
    const m = p.mins
    const ex = agg.get(key)
    if (!ex) {
      agg.set(key, {
        staff_code: p.staffCode, work_date: workDate, work_facility: p.workFacility, home_dept: p.homeDept,
        employment_type: p.emp.type, is_help: p.isHelp, day_type: p.dayType, clock_in: p.clockIn, clock_out: p.clockOut,
        regular_min: m[0], overtime_min: m[1], extra_overtime_min: m[2], night_regular_min: m[3], night_ot_min: m[4], night_extra_min: m[5],
        holiday_regular_min: m[6], holiday_ot_min: m[7], holiday_extra_min: m[8], holiday_night_min: m[9],
        break_min: m[10], total_work_min: m[11], late_min: m[12], early_min: m[13], source_file: fileName,
      })
    } else {
      ex.regular_min += m[0]; ex.overtime_min += m[1]; ex.extra_overtime_min += m[2]
      ex.night_regular_min += m[3]; ex.night_ot_min += m[4]; ex.night_extra_min += m[5]
      ex.holiday_regular_min += m[6]; ex.holiday_ot_min += m[7]; ex.holiday_extra_min += m[8]
      ex.holiday_night_min += m[9]; ex.break_min += m[10]; ex.total_work_min += m[11]
      ex.late_min += m[12]; ex.early_min += m[13]
      if (p.clockIn && (!ex.clock_in || p.clockIn < ex.clock_in)) ex.clock_in = p.clockIn
      if (p.clockOut && (!ex.clock_out || p.clockOut > ex.clock_out)) ex.clock_out = p.clockOut
      ex.is_help = ex.is_help || p.isHelp
    }
  }

  return {
    workDate, rows: [...agg.values()], staff: [...staffMap.values()], totalRows: parsed.length,
    facilityMode: perRow ? 'per-row' : 'single', facilityName: title.name,
  }
}
