/**
 * 渗漏水处置的全部状态流转都在这里：服务层之外不允许改渗漏数据。
 * 同时负责两条跨模块回写（渗漏返工待复核、安防整改待办）与值班台账同步，
 * 回写全部走同一个对账函数，保证待办条数与来源台账始终一致。
 */
import { listRows, saveRows } from '@/data/local-store'
import {
  ACTIVE_STATUSES,
  DEGREE_INTERRUPTED,
  DEGREE_MEASURED,
  DEGREE_PENDING,
  type Actor,
  deriveByDegree,
  dispatchBlockers,
  isActive,
  isBlank,
  leakPointKey,
  rowPointKey,
  todayString,
} from '@/data/leak-rules'
import type { ActionResult, EntryRow } from '@/data/types'

type Result = ActionResult

const LEAK = 'leak'
const MAINTENANCE = 'maintenance'
const ACCESS = 'access'
const DUTY = 'duty'

const SOURCE_REWORK = '渗漏返工'
const SOURCE_SECURITY = '安防整改'
const REVIEW_WAITING = '待复核'
const REVIEW_PASSED = '复核通过'

export const UNMEASURED_REASON_LEGACY = '上线前存量单据，原始资料未记录渗漏程度'

function ok(message: string): Result {
  return { ok: true, message }
}
function fail(message: string): Result {
  return { ok: false, message }
}

function nextId(rows: EntryRow[]): number {
  return rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
}

function nextCode(rows: EntryRow[], prefix: string): string {
  const max = rows.reduce((acc, row) => {
    const code = String(row['检修编号'] ?? '')
    const match = code.match(/(\d+)$/)
    return match ? Math.max(acc, Number(match[1])) : acc
  }, 0)
  return `${prefix}${String(max + 1).padStart(4, '0')}`
}

/** 归属单位不同的单据只读：任何写动作先过这道闸口；归属信息留空的老单据不拦。 */
function canWrite(row: EntryRow, actor: Actor): boolean {
  const owner = String(row['归属单位'] ?? '').trim()
  return owner === '' || owner === actor.unit
}

function stamp(row: EntryRow, actor: Actor): EntryRow {
  return { ...row, 归属单位: row['归属单位'] ?? actor.unit, 归属岗位: row['归属岗位'] ?? actor.post }
}

// ---------------------------------------------------------------------------
// 值班台账同步：处置动作与待办回写/核销都追加一条，按 key 去重，与清单保持同步更新。
// ---------------------------------------------------------------------------

export function appendDutyLog(key: string, text: string): void {
  const date = todayString()
  const rows = listRows(DUTY)
  const line = `[${date}] ${text}（${key}）`
  const index = rows.findIndex((row) => String(row['值班日期']) === date)
  if (index >= 0) {
    const items = String(rows[index]['交接事项'] ?? '')
    if (items.includes(key)) {
      return
    }
    rows[index] = { ...rows[index], 交接事项: items ? `${items}\n${line}` : line }
    saveRows(DUTY, rows)
    return
  }
  const created: EntryRow = {
    id: nextId(rows),
    status: '待交接',
    pending: true,
    abnormal: false,
    交接编号: `DUTY-AUTO-${date}`,
    值班班组: '当日值班班组',
    值班日期: date,
    班次: '系统自动登记',
    值班人员: '值班岗位',
    交接事项: line,
    交接人员: '',
    交接状态: '',
  }
  saveRows(DUTY, [...rows, created])
}

// ---------------------------------------------------------------------------
// 跨模块对账：待办只在这里增、删、核销，来源台账是唯一事实源。
// ---------------------------------------------------------------------------

function openReworkLeaks(leaks: EntryRow[]): EntryRow[] {
  return leaks.filter((row) => String(row['复核状态'] ?? '') === REVIEW_WAITING)
}

function openSecurityAccess(accessRows: EntryRow[]): EntryRow[] {
  return accessRows.filter((row) => String(row.status) === '需整改')
}

/**
 * 按来源台账逐条核对检修待办：
 * - 渗漏返工：复核状态为「待复核」的处置单必须恰有一条「待复核」待办；
 * - 安防整改：安防台账每条「需整改」必须恰有一条待办，恢复正常即核销。
 * 多出的重复待办删除，来源已闭环的待办核销，全程幂等。
 */
export function reconcileTodos(actor: Actor): {
  reworkTodos: number
  reworkSources: number
  securityTodos: number
  securitySources: number
  balanced: boolean
} {
  const leaks = listRows(LEAK)
  const accessRows = listRows(ACCESS)
  const todos = listRows(MAINTENANCE)

  const reworkKeys = new Set(openReworkLeaks(leaks).map((row) => String(row['处置编号'])))
  const securityKeys = new Set(openSecurityAccess(accessRows).map((row) => String(row['点位编号'])))

  const kept: EntryRow[] = []
  const seenRework = new Set<string>()
  const seenSecurity = new Set<string>()
  let created = 0

  for (const todo of todos) {
    const source = String(todo['关联来源'] ?? '')
    if (source !== SOURCE_REWORK && source !== SOURCE_SECURITY) {
      kept.push(todo)
      continue
    }
    const key = String(todo['关联单号'] ?? '')
    if (source === SOURCE_REWORK) {
      if (!reworkKeys.has(key)) {
        continue // 返工结论已闭环：核销
      }
      if (seenRework.has(key)) {
        continue // 同一条返工挂出了多条待办：只留一条
      }
      seenRework.add(key)
      kept.push({ ...todo, status: REVIEW_WAITING, pending: true })
    } else {
      if (!securityKeys.has(key)) {
        continue // 安防点位已恢复正常：核销
      }
      if (seenSecurity.has(key)) {
        continue
      }
      seenSecurity.add(key)
      kept.push({ ...todo, status: REVIEW_WAITING, pending: true })
    }
  }

  const leakByCode = new Map(leaks.map((row) => [String(row['处置编号']), row]))
  for (const code of reworkKeys) {
    if (seenRework.has(code)) {
      continue
    }
    const leak = leakByCode.get(code)
    if (!leak) {
      continue
    }
    created += 1
    kept.push({
      id: nextId(kept),
      status: REVIEW_WAITING,
      pending: true,
      abnormal: false,
      检修编号: nextCode(kept, 'MAIN-RW-'),
      检修对象: `渗漏返工待复核 ${code}`,
      检修类别: '渗漏水处置返工',
      检修班组: String(leak['处置班组'] ?? ''),
      计划工期: '',
      完工日期: '',
      更换部件: '',
      关联来源: SOURCE_REWORK,
      关联单号: code,
      待复核内容: `返工原因：${String(leak['返工原因'] ?? '')}；点位：${String(leak['渗漏点位'] ?? '')}`,
      归属单位: String(leak['归属单位'] ?? actor.unit),
      归属岗位: String(leak['归属岗位'] ?? actor.post),
    } as EntryRow)
  }

  const accessByCode = new Map(accessRows.map((row) => [String(row['点位编号']), row]))
  for (const code of securityKeys) {
    if (seenSecurity.has(code)) {
      continue
    }
    const point = accessByCode.get(code)
    if (!point) {
      continue
    }
    created += 1
    kept.push({
      id: nextId(kept),
      status: REVIEW_WAITING,
      pending: true,
      abnormal: false,
      检修编号: nextCode(kept, 'MAIN-AC-'),
      检修对象: `安防整改待办 ${code}`,
      检修类别: '门禁安防整改',
      检修班组: '安防维保班组',
      计划工期: '',
      完工日期: '',
      更换部件: '',
      关联来源: SOURCE_SECURITY,
      关联单号: code,
      待复核内容: `安防点位「${String(point['所属出入口'] ?? '')}」状态为需整改`,
      归属单位: '第一管廊管理所',
      归属岗位: '安防管理岗',
    } as EntryRow)
  }

  if (created > 0 || kept.length !== todos.length) {
    saveRows(MAINTENANCE, kept)
  }

  const reworkTodos = kept.filter(
    (row) => String(row['关联来源']) === SOURCE_REWORK && String(row.status) === REVIEW_WAITING,
  ).length
  const securityTodos = kept.filter(
    (row) => String(row['关联来源']) === SOURCE_SECURITY && String(row.status) === REVIEW_WAITING,
  ).length
  const reworkSources = reworkKeys.size
  const securitySources = securityKeys.size
  return {
    reworkTodos,
    reworkSources,
    securityTodos,
    securitySources,
    balanced: reworkTodos === reworkSources && securityTodos === securitySources,
  }
}

// ---------------------------------------------------------------------------
// 处置单动作
// ---------------------------------------------------------------------------

export function leakRows(): EntryRow[] {
  return listRows(LEAK)
}

export function createLeak(
  input: Partial<EntryRow>,
  actor: Actor,
  options: { source?: string; note?: string } = {},
): Result {
  const point = String(input['渗漏点位'] ?? '').trim()
  const cabin = String(input['所属舱室'] ?? '').trim()
  if (!point) {
    return fail('渗漏点位必填，不能登记没有点位的处置单')
  }
  if (!cabin) {
    return fail('所属舱室必填：判重口径是「所属舱室+渗漏点位」，缺舱室无法判重')
  }
  const rows = listRows(LEAK)
  const key = leakPointKey(cabin, point)
  const duplicated = rows.find((row) => isActive(row.status) && rowPointKey(row) === key)
  if (duplicated) {
    return fail(
      `渗漏点 ${cabin}/${point} 已有未闭环处置单 ${String(duplicated['处置编号'])}（${String(duplicated.status)}），同一渗漏点只派一次工`,
    )
  }

  const degree = String(input['渗漏程度'] ?? '').trim()
  const degreeState = degree ? DEGREE_MEASURED : String(input['程度状态'] ?? DEGREE_PENDING)
  if (![DEGREE_MEASURED, DEGREE_PENDING, DEGREE_INTERRUPTED].includes(degreeState)) {
    return fail('程度状态只能是已实测、待测、测取中断')
  }
  const reason = String(input['未测原因'] ?? '').trim()
  if (degreeState !== DEGREE_MEASURED && !reason) {
    return fail(degreeState === DEGREE_PENDING ? '渗漏程度待测必须写明待测原因' : '测取中断必须写明中断原因')
  }
  const derived = degree ? deriveByDegree(degree) : { level: '', method: '' }
  if (degree && !derived.level) {
    return fail(`渗漏程度取值不在现场实测口径内：${degree}`)
  }

  const id = nextId(rows)
  const foundDate = String(input['发现日期'] ?? '').trim() || todayString()
  const row: EntryRow = {
    id,
    status: '待处置',
    pending: true,
    abnormal: false,
    处置编号: `LEAK-${String(id).padStart(4, '0')}`,
    所属舱室: cabin,
    渗漏点位: point,
    渗漏程度: degree,
    程度状态: degreeState,
    渗漏等级: derived.level,
    处置方式: String(input['处置方式'] ?? '').trim() || derived.method,
    处置班组: String(input['处置班组'] ?? '').trim(),
    发现日期: foundDate,
    完工日期: '',
    返工原因: '',
    未测原因: degreeState === DEGREE_MEASURED ? '' : reason,
    取值说明: '',
    复核状态: '',
    数据来源: options.source ?? '运行期登记',
    缺项标注: options.note ?? '',
    归属单位: actor.unit,
    归属岗位: actor.post,
  }
  saveRows(LEAK, [...rows, row])
  appendDutyLog(`leak-create-${id}`, `${actor.post}登记渗漏处置单 ${String(row['处置编号'])}（${cabin}/${point}）`)
  return ok(`已登记处置单 ${String(row['处置编号'])}，渗漏程度${degree ? '现场已实测' : `空态：${degreeState}`}`)
}

type DegreePayload = { measured: true; degree: string; note?: string } | { measured: false; state: string; reason: string }

/** 现场补测 / 重试测取的统一入口：取不到时留空态并写明原因，绝不写 0。 */
export function recordDegree(id: number, payload: DegreePayload, actor: Actor): Result {
  const rows = listRows(LEAK)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return fail(`没有找到编号为 ${id} 的渗漏处置单`)
  }
  const current = rows[index]
  if (!canWrite(current, actor)) {
    return fail(`跨单位单据只读：${String(current['处置编号'])}归${String(current['归属单位'])}，本单位无权提交`)
  }

  const updated: EntryRow = { ...current }
  if (payload.measured) {
    const degree = String(payload.degree ?? '').trim()
    const derived = deriveByDegree(degree)
    if (!degree || !derived.level) {
      return fail('现场实测渗漏程度取值不在口径内（干裂缝/面渗/滴漏/线漏/涌水）')
    }
    const previous = String(current['渗漏程度'] ?? '').trim()
    const note = String(payload.note ?? '').trim()
    if (previous && previous !== degree) {
      updated['取值说明'] = `初判「${previous}」与现场实测「${degree}」打架，以现场实测为准，渗漏等级、处置方式按实测重算。${note}`
    } else if (note) {
      updated['取值说明'] = note
    }
    updated['渗漏程度'] = degree
    updated['程度状态'] = DEGREE_MEASURED
    updated['渗漏等级'] = derived.level
    // 处置方式是实测的派生项：之前按空态/估算填的，一律按实测重算覆盖。
    updated['处置方式'] = derived.method
    updated['未测原因'] = ''
  } else {
    if (![DEGREE_PENDING, DEGREE_INTERRUPTED].includes(payload.state)) {
      return fail('取不到实测值时，空态只能标「待测」或「测取中断」')
    }
    if (!payload.reason.trim()) {
      return fail(payload.state === DEGREE_PENDING ? '待测必须写明原因' : '测取中断必须写明中断原因')
    }
    updated['渗漏程度'] = ''
    updated['渗漏等级'] = ''
    updated['处置方式'] = String(current['处置方式'] ?? '')
    updated['程度状态'] = payload.state
    updated['未测原因'] = payload.reason.trim()
  }
  rows[index] = updated
  saveRows(LEAK, rows)
  appendDutyLog(
    `leak-degree-${id}-${updated['程度状态']}`,
    `${actor.post}${payload.measured ? '现场实测回填' : `标记${payload.state}`}渗漏程度：${String(updated['处置编号'])}`,
  )
  return ok(`${String(updated['处置编号'])}渗漏程度已更新：${String(updated['程度状态'])}`)
}

/** 重试入口：把上一次没取到的数据重新取一遍（仅待测/中断的单可用，返工重新派出后也走这里）。 */
export function retryMeasure(id: number, payload: DegreePayload, actor: Actor): Result {
  const rows = listRows(LEAK)
  const row = rows.find((item) => Number(item.id) === id)
  if (!row) {
    return fail(`没有找到编号为 ${id} 的渗漏处置单`)
  }
  const state = String(row['程度状态'] ?? '')
  if (state === DEGREE_MEASURED && payload.measured) {
    // 允许复测覆盖（仍以最新现场实测为准并重算）
  } else if (state === DEGREE_MEASURED) {
    return fail('该单渗漏程度已实测，不允许再标成空态')
  }
  const result = recordDegree(id, payload, actor)
  if (result.ok) {
    appendDutyLog(`leak-retry-${id}`, `${actor.post}重试测取渗漏程度：${String(row['处置编号'])}`)
  }
  return result
}

export function dispatchLeak(id: number, actor: Actor): Result {
  const rows = listRows(LEAK)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return fail(`没有找到编号为 ${id} 的渗漏处置单`)
  }
  const current = rows[index]
  if (!canWrite(current, actor)) {
    return fail(`跨单位单据只读：${String(current['处置编号'])}归${String(current['归属单位'])}，本单位无权派工`)
  }
  const blockers = dispatchBlockers(current)
  if (blockers.length) {
    return fail(`处置单不能带空值进入处置中，缺少：${blockers.join('、')}`)
  }
  const dup = rows.find(
    (row) =>
      Number(row.id) !== id &&
      isActive(row.status) &&
      rowPointKey(row) === rowPointKey(current),
  )
  if (dup) {
    return fail(`同一渗漏点已有未闭环处置单 ${String(dup['处置编号'])}，不能重复派工`)
  }
  rows[index] = { ...current, status: '处置中', pending: true, abnormal: false }
  saveRows(LEAK, rows)
  appendDutyLog(`leak-dispatch-${id}`, `${actor.post}派出处置 ${String(current['处置编号'])}（${current['处置班组']}）`)
  return ok(`${String(current['处置编号'])}已派出处置，进入处置中`)
}

export function completeLeak(id: number, actor: Actor): Result {
  const rows = listRows(LEAK)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return fail(`没有找到编号为 ${id} 的渗漏处置单`)
  }
  const current = rows[index]
  if (!canWrite(current, actor)) {
    return fail(`跨单位单据只读：${String(current['处置编号'])}归${String(current['归属单位'])}，本单位无权提交`)
  }
  if (String(current.status) !== '处置中') {
    return fail(`只有处置中的处置单能确认完工，当前「${String(current.status)}」`)
  }
  rows[index] = { ...current, status: '已完工', pending: false, 完工日期: todayString() }
  saveRows(LEAK, rows)
  appendDutyLog(`leak-complete-${id}`, `${actor.post}确认完工 ${String(current['处置编号'])}`)
  return ok(`${String(current['处置编号'])}已完工`)
}

/** 要求返工：返工原因必填，并把返工结论回写到设施检修管理待办（待复核）。 */
export function requestRework(id: number, reason: string, actor: Actor): Result {
  const trimmed = reason.trim()
  if (!trimmed) {
    return fail('要求返工必须填写返工原因，空原因一律不受理')
  }
  const rows = listRows(LEAK)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return fail(`没有找到编号为 ${id} 的渗漏处置单`)
  }
  const current = rows[index]
  if (!canWrite(current, actor)) {
    return fail(`跨单位单据只读：${String(current['处置编号'])}归${String(current['归属单位'])}，本单位无权提交返工`)
  }
  if (String(current.status) !== '已完工') {
    return fail(`只有已完工的处置单能要求返工，当前「${String(current.status)}」`)
  }
  rows[index] = {
    ...current,
    status: '需返工',
    pending: true,
    abnormal: true,
    返工原因: trimmed,
    复核状态: REVIEW_WAITING,
  }
  saveRows(LEAK, rows)
  const report = reconcileTodos(actor)
  appendDutyLog(
    `leak-rework-${id}`,
    `${actor.post}要求返工 ${String(current['处置编号'])}，返工结论已回写设施检修管理待办（待复核）`,
  )
  return ok(
    `已登记返工原因并回写检修待办；返工待办 ${report.reworkTodos} 条，与返工来源 ${report.reworkSources} 条一致`,
  )
}

/**
 * 返工重新派出：上一次没取到的数据必须重新取——程度先回到「待测」空态，
 * 班组用「重试测取」回填实测值后才能再次派出；原返工待办仍挂着，等复核闭环。
 */
export function redispatchRework(id: number, actor: Actor): Result {
  const rows = listRows(LEAK)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return fail(`没有找到编号为 ${id} 的渗漏处置单`)
  }
  const current = rows[index]
  if (!canWrite(current, actor)) {
    return fail(`跨单位单据只读：${String(current['处置编号'])}归${String(current['归属单位'])}，本单位无权派工`)
  }
  if (String(current.status) !== '需返工') {
    return fail(`只有需返工的处置单能重新派出，当前「${String(current.status)}」`)
  }
  rows[index] = {
    ...current,
    status: '处置中',
    pending: true,
    abnormal: true,
    渗漏程度: '',
    渗漏等级: '',
    处置方式: '',
    程度状态: DEGREE_PENDING,
    未测原因: '返工后需重新现场实测，上一次数据不予沿用',
  }
  saveRows(LEAK, rows)
  appendDutyLog(`leak-redispatch-${id}`, `${actor.post}返工重新派出 ${String(current['处置编号'])}，渗漏程度回到待测待重测`)
  return ok(`${String(current['处置编号'])}已重新派出，请先用「重试测取」回填现场实测，再确认完工`)
}

/** 检修侧复核闭环：处置单返工结论销项，待办由对账函数核销。 */
export function closeReviewByTodo(todoId: number, actor: Actor): Result {
  const todos = listRows(MAINTENANCE)
  const todo = todos.find((row) => Number(row.id) === todoId)
  if (!todo) {
    return fail(`没有找到编号为 ${todoId} 的检修待办`)
  }
  if (String(todo.status) !== REVIEW_WAITING) {
    return fail(`该检修记录不在待复核状态（当前「${String(todo.status)}」）`)
  }
  const code = String(todo['关联单号'] ?? '')
  const leaks = listRows(LEAK)
  const index = leaks.findIndex((row) => String(row['处置编号']) === code)
  if (index >= 0) {
    leaks[index] = { ...leaks[index], 复核状态: REVIEW_PASSED, abnormal: false, pending: false }
    saveRows(LEAK, leaks)
  }
  const report = reconcileTodos(actor)
  appendDutyLog(`review-close-${todoId}`, `${actor.post}复核闭环检修待办 ${String(todo['检修编号'])}（${String(todo['关联来源'])} ${code}）`)
  return ok(`已复核闭环；对账后返工待办 ${report.reworkTodos}/${report.reworkSources}，安防待办 ${report.securityTodos}/${report.securitySources}`)
}

// ---------------------------------------------------------------------------
// 上线前老记录：按业务发生日（发现日期）整批补录，缺项单独标注来源，不编造数值。
// ---------------------------------------------------------------------------

export type LegacyRecord = {
  所属舱室: string
  渗漏点位: string
  发现日期: string
  渗漏程度?: string
  处置班组?: string
  处置方式?: string
}

export function backfillLegacy(records: LegacyRecord[], actor: Actor, batch: string): Result {
  const rows = listRows(LEAK)
  let added = 0
  let marked = 0
  let skipped = 0

  for (const item of records) {
    const key = leakPointKey(item.所属舱室, item.渗漏点位)
    const exists = rows.some(
      (row) =>
        rowPointKey(row) === key &&
        String(row['发现日期']) === String(item.发现日期) &&
        String(row['数据来源']) === '上线前补录',
    )
    if (exists) {
      skipped += 1
      continue
    }
    const degree = String(item['渗漏程度'] ?? '').trim()
    const missing: string[] = []
    if (!degree) {
      missing.push('渗漏程度')
    }
    if (!String(item['处置班组'] ?? '').trim()) {
      missing.push('处置班组')
    }
    if (!String(item['处置方式'] ?? '').trim()) {
      missing.push('处置方式')
    }
    const derived = degree ? deriveByDegree(degree) : { level: '', method: '' }
    const id = nextId(rows) + added
    const row: EntryRow = {
      id,
      status: '已完工',
      pending: false,
      abnormal: false,
      处置编号: `LEAK-${String(id).padStart(4, '0')}`,
      所属舱室: String(item.所属舱室 ?? '').trim(),
      渗漏点位: String(item.渗漏点位 ?? '').trim(),
      渗漏程度: derived.level ? degree : '',
      程度状态: derived.level ? DEGREE_MEASURED : DEGREE_PENDING,
      渗漏等级: derived.level,
      处置方式: String(item['处置方式'] ?? '').trim() || derived.method,
      处置班组: String(item['处置班组'] ?? '').trim(),
      发现日期: String(item.发现日期),
      完工日期: String(item.发现日期),
      返工原因: '',
      未测原因: derived.level ? '' : UNMEASURED_REASON_LEGACY,
      取值说明: '',
      复核状态: '',
      数据来源: '上线前补录',
      缺项标注: missing.length
        ? `批次${batch}；缺项：${missing.join('、')}（来源：${UNMEASURED_REASON_LEGACY}）`
        : `批次${batch}；字段来源：纸质处置台账`,
      归属单位: actor.unit,
      归属岗位: actor.post,
    }
    rows.push(row)
    added += 1
    if (missing.length) {
      marked += 1
    }
  }

  if (added > 0) {
    saveRows(LEAK, rows)
    appendDutyLog(`leak-backfill-${batch}`, `${actor.post}整批补录上线前渗漏处置单 ${added} 条（批次${batch}），缺项标注 ${marked} 条`)
  }
  return ok(`批次${batch}补录完成：新增 ${added} 条，缺项单独标注 ${marked} 条，重复跳过 ${skipped} 条`)
}

export function leakStats(rows: EntryRow[]) {
  const count = (status: string) => rows.filter((row) => String(row.status) === status).length
  const unmeasured = rows.filter(
    (row) => [DEGREE_PENDING, DEGREE_INTERRUPTED].includes(String(row['程度状态'])),
  ).length
  const monthPrefix = todayString().slice(0, 7)
  const finishedThisMonth = rows.filter(
    (row) => String(row.status) === '已完工' && String(row['完工日期']).startsWith(monthPrefix),
  ).length
  return {
    waiting: count('待处置'),
    working: count('处置中'),
    rework: count('需返工'),
    unmeasured,
    finishedThisMonth,
    total: rows.length,
  }
}

export { ACTIVE_STATUSES }
