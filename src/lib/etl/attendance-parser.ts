// 勤怠CSV（Touch On Time / 拡張子.xls・実体HTML・UTF-8）パーサー
// 1ファイル = 1日分・全所属。HTMLテーブルを解析して raw_attendance_daily 行 + dim_staff を生成。
// 所属コード→BI施設コードの変換はこの定数を正とする（scripts/sql/productivity.sql の seed と一致させること）。

export interface AttendanceInsert {
  staff_code: string
  work_date: string // 'YYYY-MM-DD'
  work_facility: string | null // 計上先（ヘルプ先含む。BIコード）
  home_dept: string | null // 本務（BIコード）
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
  workDate: string // 'YYYY-MM-DD'
  rows: AttendanceInsert[]
  staff: StaffInsert[]
  totalRows: number // パースした明細行数（参考）
}

// 勤怠所属コード → BI施設コード（本社部門は 'HQ'）
const FACILITY_MAP: Record<string, string> = {
  '102': 'NS', '103': 'GZ', '104': 'MH', '105': 'KT', '106': 'OQ', '107': 'AP',
  '108': 'MI', '110': 'TR', '111': 'IK', '112': 'ON', '113': 'OY', '114': 'YZ',
  '115': 'SY', '116': 'SR', '117': 'KR', '118': 'TK', '119': 'BSN', '120': 'YNT',
  '121': 'FRY', '122': 'HGY', '123': 'NIE', '124': 'OOH', '125': 'HRM', '126': 'KJK',
  '127': 'AOY', '128': 'KMY', '129': 'MRM',
  // 本社・管理部門
  '100': 'HQ', '1000': 'HQ', '1001': 'HQ', '1002': 'HQ', '1003': 'HQ',
  '1004': 'HQ', '1006': 'HQ', '1007': 'HQ', '1008': 'HQ',
}

const leadingCode = (s: string): string | null => {
  const m = s.trim().match(/^(\d+)/)
  return m ? m[1] : null
}

// "11.20"(小数時間) または "8:30"(時:分) → 分。空欄→0。
const toMin = (raw: string): number => {
  const s = raw.replace(/\s+/g, '').trim()
  if (!s || s === '-') return 0
  if (s.includes(':')) {
    const [h, m] = s.split(':')
    return Math.round((Number(h) || 0) * 60 + (Number(m) || 0))
  }
  const v = parseFloat(s)
  return isNaN(v) ? 0 : Math.round(v * 60)
}

// 打刻セル "FeliCa 06/23 10:19 ヘルプ..." → { mm, dd, hhmm }
const parsePunch = (s: string): { mm: number; dd: number; hhmm: string } | null => {
  const m = s.match(/(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2})/)
  if (!m) return null
  return { mm: Number(m[1]), dd: Number(m[2]), hhmm: `${m[3].padStart(2, '0')}:${m[4]}` }
}

const cellText = (td: Element): string =>
  (td.textContent ?? '').replace(/ /g, ' ').replace(/\s+/g, ' ').trim()

const empType = (s: string): { type: string; monthly: boolean } => {
  if (/アルバイト|パート/.test(s)) return { type: 'アルバイト', monthly: false }
  return { type: '正社員', monthly: true }
}

// ファイル名 "...list20260624142552.xls" から年月日を取得
const fileDate = (name: string): { y: number; mo: number; d: number } | null => {
  const m = name.match(/(\d{4})(\d{2})(\d{2})\d{0,6}/)
  if (!m) return null
  return { y: Number(m[1]), mo: Number(m[2]), d: Number(m[3]) }
}

export function parseAttendanceHtml(html: string, fileName: string): AttendanceParseResult {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const trs = Array.from(doc.querySelectorAll('tr'))
  const fd = fileDate(fileName)

  type Parsed = {
    staffCode: string; name: string; emp: { type: string; monthly: boolean }
    workFacility: string | null; homeDept: string | null; isHelp: boolean
    dayType: string | null; clockIn: string | null; clockOut: string | null
    mins: number[]; punchMM: number | null; punchDD: number | null
  }
  const parsed: Parsed[] = []
  const dateVotes = new Map<string, number>() // "mm-dd" → count

  for (const tr of trs) {
    const tds = Array.from(tr.querySelectorAll('td'))
    if (tds.length < 30) continue
    const c = tds.map(cellText)

    const staffCode = leadingCode(c[3])
    if (!staffCode) continue // ヘッダー/合計行などをスキップ

    const name = c[3].replace(/^\d+\s*/, '').trim()
    const emp = empType(c[2])

    // 所属 → 計上先/本務
    let workFacility: string | null
    let homeDept: string | null
    let isHelp = false
    if (c[1].includes('ヘルプ')) {
      const [homePart, helpPart] = c[1].split('ヘルプ')
      const homeCode = leadingCode(homePart)
      const helpCode = leadingCode(helpPart ?? '')
      homeDept = homeCode ? FACILITY_MAP[homeCode] ?? null : null
      workFacility = helpCode ? FACILITY_MAP[helpCode] ?? null : null
      isHelp = true
    } else {
      const code = leadingCode(c[1])
      workFacility = code ? FACILITY_MAP[code] ?? null : null
      homeDept = workFacility
    }

    const inP = parsePunch(c[10])
    const outP = parsePunch(c[11])
    if (inP) dateVotes.set(`${inP.mm}-${inP.dd}`, (dateVotes.get(`${inP.mm}-${inP.dd}`) ?? 0) + 1)

    parsed.push({
      staffCode, name, emp, workFacility, homeDept, isHelp,
      dayType: c[9] || null,
      clockIn: inP?.hhmm ?? null,
      clockOut: outP?.hhmm ?? null,
      punchMM: inP?.mm ?? null, punchDD: inP?.dd ?? null,
      mins: [
        toMin(c[14]), toMin(c[15]), toMin(c[16]),      // 所定/所定外/残業
        toMin(c[17]), toMin(c[18]), toMin(c[19]),      // 深夜 所定/所定外/残業
        toMin(c[20]), toMin(c[21]), toMin(c[22]),      // 休日 所定/所定外/残業
        toMin(c[23]) + toMin(c[24]) + toMin(c[25]),    // 休日深夜（合算）
        toMin(c[28]), toMin(c[29]),                     // 休憩/労働合計
        toMin(c[26]), toMin(c[27]),                     // 遅刻/早退
      ],
    })
  }

  // ファイルの勤務日 = 出勤打刻日の最頻値（年はファイル名から。12月⇄1月の越年だけ補正）
  let mm = fd?.mo ?? 1, dd = fd?.d ?? 1
  let best = -1
  for (const [k, v] of dateVotes) {
    if (v > best) { best = v; const [a, b] = k.split('-'); mm = Number(a); dd = Number(b) }
  }
  let year = fd?.y ?? new Date().getFullYear()
  if (fd && mm === 12 && fd.mo === 1) year -= 1
  const workDate = `${year}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`

  // (staff_code, work_facility) で集約（同一キーの複数行は合算 / 打刻は最早・最遅）
  const agg = new Map<string, AttendanceInsert>()
  const staffMap = new Map<string, StaffInsert>()
  for (const p of parsed) {
    if (!staffMap.has(p.staffCode)) {
      staffMap.set(p.staffCode, {
        staff_code: p.staffCode, name: p.name, home_facility: p.homeDept,
        employment_type: p.emp.type, is_monthly_salary: p.emp.monthly,
      })
    }
    const key = `${p.staffCode}|${p.workFacility ?? ''}`
    const m = p.mins
    const ex = agg.get(key)
    if (!ex) {
      agg.set(key, {
        staff_code: p.staffCode, work_date: workDate,
        work_facility: p.workFacility, home_dept: p.homeDept,
        employment_type: p.emp.type, is_help: p.isHelp, day_type: p.dayType,
        clock_in: p.clockIn, clock_out: p.clockOut,
        regular_min: m[0], overtime_min: m[1], extra_overtime_min: m[2],
        night_regular_min: m[3], night_ot_min: m[4], night_extra_min: m[5],
        holiday_regular_min: m[6], holiday_ot_min: m[7], holiday_extra_min: m[8],
        holiday_night_min: m[9], break_min: m[10], total_work_min: m[11],
        late_min: m[12], early_min: m[13], source_file: fileName,
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
    workDate,
    rows: [...agg.values()],
    staff: [...staffMap.values()],
    totalRows: parsed.length,
  }
}
