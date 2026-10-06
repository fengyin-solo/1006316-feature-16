import { listRows, saveRows } from '@/data/local-store'
import type { EntryRow } from '@/data/types'
import { useSessionStore, type Actor } from '@/stores/session'

// 渗漏水处置领域服务：docs/渗漏水处置边界规则.md 的可执行口径。
// 页面只渲染、不做业务判断；所有强校验、跨模块回写都集中在本文件。

const LEAK_KEY = 'leak'
const MAIN_KEY = 'maintenance'
const ACCESS_KEY = 'access'
const DUTY_KEY = 'duty'

export const OPEN_STATUSES = ['待处置', '处置中', '需返工', '待复核']
const REVIEW_STATUSES = ['需返工', '待复核']
const HISTORY_REASON = '历史档案仅登记渗漏部位，无程度观测记录（历史缺记）'

// ---- 渗漏程度五级口径（实测流量 L/min 判定）----
export type SeverityGrade = { grade: string; suggest: string }

export function gradeByFlow(flow: number): SeverityGrade {
  if (flow === 0) return { grade: '无渗漏（干裂缝）', suggest: '封闭观察' }
  if (flow < 0.1) return { grade: '湿渍（Ⅰ级）', suggest: '表面封堵' }
  if (flow < 1) return { grade: '慢渗（Ⅱ级）', suggest: '注浆封堵' }
  if (flow < 10) return { grade: '快渗（Ⅲ级）', suggest: '导流+注浆（提级响应）' }
  return { grade: '涌漏（Ⅳ级）', suggest: '导流+注浆+应急提级' }
}

// ---- 判重：点位文字 → 点位编码（舱室/桩号/部位）----
const CABIN_RE = /(综合舱|电力舱|水信舱|燃气舱|热力舱|污水舱|雨水舱)/
const STAKING_RE = /([A-Z]\d+\+\d+(?:\.\d+)?)/

export function normalizePointCode(text: string): string | null {
  const raw = (text ?? '')
    .trim()
    .replace(/[！-～]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .toUpperCase()
  const cabin = raw.match(CABIN_RE)?.[1] ?? ''
  const staking = raw.match(STAKING_RE)?.[1] ?? ''
  if (!cabin || !staking) return null
  const stakeNorm = staking.replace(/(\.\d+?)0+$/, '$1').replace(/\.0$/, '')
  const part = raw
    .replace(cabin, '')
    .replace(staking, '')
    .replace(/[，。、,.:：;；（）()\s]/g, '')
  return `${cabin}/${stakeNorm}/${part || '未标部位'}`
}

// ---- 小工具 ----
function today(): string {
  return new Date().toISOString().slice(0, 10)
}

function nextId(rows: EntryRow[]): number {
  return rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
}

function nextLeakNo(rows: EntryRow[]): string {
  const max = rows.reduce((acc, row) => {
    const m = /^LEAK-(\d+)$/.exec(String(row.处置编号 ?? ''))
    return m ? Math.max(acc, Number(m[1])) : acc
  }, 0)
  return `LEAK-${String(max + 1).padStart(4, '0')}`
}

function appendHistory(row: EntryRow, line: string): void {
  const stamp = `${today()} ${new Date().toTimeString().slice(0, 5)}`
  const prev = String(row.处置履历 ?? '')
  row.处置履历 = prev ? `${prev}\n${stamp} ${line}` : `${stamp} ${line}`
}

function isMeasured(row: EntryRow): boolean {
  return row.程度状态 === '已实测' && row.实测流量 !== '' && row.实测流量 != null
}

// 派工/流转前缺项清单（区分空态与中断，禁止把没测到当 0）
export function missingBeforeDispatch(row: EntryRow): string[] {
  const missing: string[] = []
  if (!row.点位编码) missing.push('点位编码待补（点位描述缺舱室或桩号）')
  if (!isMeasured(row)) {
    if (row.程度状态 === '中断') missing.push(`渗漏程度测量中断：${row.中断原因 || '未填中断原因'}`)
    else missing.push(`渗漏程度待测：${row.未测原因 || '未填未测原因'}`)
  }
  if (!String(row.处置方式 ?? '').trim()) missing.push('处置方式未确定')
  if (!String(row.处置班组 ?? '').trim()) missing.push('处置班组未安排')
  return missing
}

function assertWritable(row: EntryRow, actor: Actor): void {
  if (row.归属单位 && row.归属单位 !== actor.unit) {
    throw new Error(`跨单位只读：该处置单归属「${row.归属单位}」，${actor.unit}无权提交`)
  }
}

function findLeak(rows: EntryRow[], id: number): EntryRow {
  const row = rows.find((item) => Number(item.id) === id)
  if (!row) throw new Error(`没有找到编号为 ${id} 的渗漏处置单`)
  return row
}

// ---- 跨模块联动：检修待办 RVW-<处置编号>，幂等 upsert ----
function reviewNo(leak: EntryRow): string {
  return `RVW-${leak.处置编号}`
}

function upsertReviewTodo(
  maintenance: EntryRow[],
  leak: EntryRow,
  actor: Actor,
  patch: { status: string; pending: boolean; note?: string },
): EntryRow[] {
  const no = reviewNo(leak)
  const index = maintenance.findIndex((row) => row.检修编号 === no)
  const base: EntryRow =
    index >= 0
      ? { ...maintenance[index] }
      : {
          id: nextId(maintenance),
          status: '待复核',
          pending: true,
          abnormal: false,
          检修编号: no,
          检修对象: leak.渗漏点位,
          检修类别: '渗漏返工复核',
          检修班组: leak.处置班组 || '待安排',
          计划工期: '3 个工作日内',
          完工日期: '',
          更换部件: '',
          联动处置单: leak.处置编号,
          来源: '渗漏联动',
          归属单位: leak.归属单位,
          归口岗位: '设施检修岗',
        }
  base.status = patch.status
  base.pending = patch.pending
  if (patch.note) base.复核备注 = patch.note
  const next = [...maintenance]
  if (index >= 0) next[index] = base
  else next.push(base)
  return next
}

// ---- 安防台账联动：LINK-<处置编号>，与检修待办 1:1 ----
function upsertAccessLink(
  access: EntryRow[],
  leak: EntryRow,
  actor: Actor,
  patch: { status: string; pending: boolean },
): EntryRow[] {
  const no = `LINK-${leak.处置编号}`
  const index = access.findIndex((row) => row.点位编号 === no)
  const base: EntryRow =
    index >= 0
      ? { ...access[index] }
      : {
          id: nextId(access),
          status: '需整改',
          pending: true,
          abnormal: true,
          点位编号: no,
          所属出入口: String(leak.点位编码 ?? leak.渗漏点位),
          门禁类型: '渗漏联动整改点',
          监控覆盖: '已纳入整改复核',
          授权人数: '—',
          检查日期: today(),
          检查人员: actor.operator,
          安防状态: '需整改',
          来源: '渗漏联动',
          联动处置单: leak.处置编号,
          归属单位: leak.归属单位,
        }
  base.status = patch.status
  base.pending = patch.pending
  base.安防状态 = patch.status
  const next = [...access]
  if (index >= 0) next[index] = base
  else next.push(base)
  return next
}

// ---- 值班清单联动：同(班次,处置单,动作)幂等追加 ----
function appendDutyEvent(
  duty: EntryRow[],
  leak: EntryRow,
  action: string,
  actor: Actor,
): EntryRow[] {
  const shift = useSessionStore().shiftLabel
  const event = `[渗漏联动] ${leak.处置编号} ${leak.渗漏点位} ${action}（${actor.operator}/${actor.unit}）`
  const todayStr = today()
  let index = duty.findIndex((row) => row.值班日期 === todayStr)
  let row: EntryRow
  if (index < 0) {
    row = {
      id: nextId(duty),
      status: '交接中',
      pending: true,
      abnormal: false,
      交接编号: `DUTY-${String(nextId(duty)).padStart(4, '0')}`,
      值班班组: '当前值班组',
      值班日期: todayStr,
      班次: shift,
      值班人员: actor.operator,
      交接事项: event,
      交接人员: '',
      交接状态: '交接中',
    }
  } else {
    row = { ...duty[index] }
    const items = String(row.交接事项 ?? '')
    const dupKey = `${leak.处置编号} ${action}`
    if (items.split('\n').some((line) => line.includes(dupKey))) return duty
    row.交接事项 = items ? `${items}\n${event}` : event
  }
  const next = [...duty]
  if (index < 0) next.push(row)
  else next[index] = row
  return next
}

// 一次跨模块写回：leak / maintenance / access / duty 同批保存，条数对不上整批拒绝
function commitLinked(
  leaks: EntryRow[],
  leak: EntryRow,
  actor: Actor,
  review: { status: string; pending: boolean; note?: string } | null,
  security: { status: string; pending: boolean } | null,
  dutyAction: string | null,
): void {
  let maintenance = listRows(MAIN_KEY)
  let access = listRows(ACCESS_KEY)
  const duty = listRows(DUTY_KEY)

  if (review) maintenance = upsertReviewTodo(maintenance, leak, actor, review)
  if (security) access = upsertAccessLink(access, leak, actor, security)
  const nextDuty = dutyAction ? appendDutyEvent(duty, leak, dutyAction, actor) : duty

  // 条数对账：本处置单在检修待办与安防台账的联动状态必须同开同闭
  const reviewOpen = maintenance.some(
    (row) => row.联动处置单 === leak.处置编号 && row.status === '待复核',
  )
  const accessOpen = access.some(
    (row) => row.联动处置单 === leak.处置编号 && row.status === '需整改',
  )
  if (reviewOpen !== accessOpen) {
    throw new Error('联动回写被拒绝：检修待复核条数与安防需整改条数无法对齐，已整批回滚')
  }

  const leakIndex = leaks.findIndex((item) => Number(item.id) === Number(leak.id))
  const nextLeaks = [...leaks]
  nextLeaks[leakIndex] = leak
  saveRows(LEAK_KEY, nextLeaks)
  saveRows(MAIN_KEY, maintenance)
  saveRows(ACCESS_KEY, access)
  saveRows(DUTY_KEY, nextDuty)
}

// ---- 对外动作 ----

export type CreateInput = {
  渗漏点位: string
  实测流量?: number | null
  未测原因?: string
  中断原因?: string
  处置班组?: string
  发现日期: string
}

export type ActionOutcome = { ok: boolean; message: string; duplicateOf?: string }

export function listLeakOrders(filters: Record<string, string> = {}): EntryRow[] {
  const rows = listRows(LEAK_KEY)
  const pairs = Object.entries(filters).filter(([, v]) => v.trim() !== '')
  if (!pairs.length) return rows
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function createLeakOrder(input: CreateInput, actor: Actor): ActionOutcome {
  const pointText = input.渗漏点位?.trim()
  if (!pointText) return { ok: false, message: '渗漏点位必填' }
  const code = normalizePointCode(pointText)
  const rows = listRows(LEAK_KEY)
  const duplicate = rows.find((row) => row.点位编码 && row.点位编码 === code && OPEN_STATUSES.includes(String(row.status)))
  if (duplicate) {
    // 判重口径：同一渗漏点有未闭环单时，拒绝再落一张未闭环单
    return {
      ok: false,
      duplicateOf: String(duplicate.处置编号),
      message: `该渗漏点位已有未闭环处置单 ${duplicate.处置编号}（状态：${duplicate.status}），请打开在办单继续处置，不要重复派工`,
    }
  }

  const flow = input.实测流量
  const hasFlow = typeof flow === 'number'
  if (hasFlow && (Number.isNaN(flow as number) || (flow as number) < 0)) {
    return { ok: false, message: '实测流量必须是非负数字；没测到请选"待测"留空，不许填 0' }
  }
  const degreeState = hasFlow ? '已实测' : input.中断原因 ? '中断' : '待测（空态）'
  if (degreeState === '待测（空态）' && !input.未测原因?.trim()) {
    return { ok: false, message: '渗漏程度取不到时必须写明未测原因，空态原因不能为空' }
  }
  if (degreeState === '中断' && !input.中断原因?.trim()) {
    return { ok: false, message: '测量中断必须写明中断原因' }
  }
  const graded = hasFlow ? gradeByFlow(flow as number) : null

  const row: EntryRow = {
    id: nextId(rows),
    status: '待处置',
    pending: true,
    abnormal: false,
    处置编号: nextLeakNo(rows),
    渗漏点位: pointText,
    点位编码: code ?? '',
    渗漏程度: graded?.grade ?? '',
    实测流量: hasFlow ? (flow as number) : '',
    程度状态: degreeState,
    未测原因: degreeState === '待测（空态）' ? input.未测原因!.trim() : '',
    中断原因: degreeState === '中断' ? input.中断原因!.trim() : '',
    采集轮次: hasFlow ? 1 : 0,
    处置方式: graded?.suggest ?? '',
    处置班组: input.处置班组?.trim() ?? '',
    发现日期: input.发现日期 || today(),
    完工日期: '',
    返工原因: '',
    来源标记: '现场实测',
    补录原值: '',
    补录批次: '',
    归属单位: actor.unit,
    归口岗位: actor.post,
    最后操作人: actor.operator,
    处置履历: '',
  }
  appendHistory(row, `登记处置单，程度${hasFlow ? '现场实测' : degreeState}`)
  saveRows(LEAK_KEY, [...rows, row])
  return {
    ok: true,
    message: code
      ? `处置单 ${row.处置编号} 已登记`
      : `处置单 ${row.处置编号} 已登记，但点位描述规范化不出编码，派工前必须补全舱室与桩号`,
  }
}

function mutate(id: number, actor: Actor, fn: (row: EntryRow, rows: EntryRow[]) => string | null): ActionOutcome {
  try {
    const rows = listRows(LEAK_KEY)
    const row = findLeak(rows, id)
    assertWritable(row, actor)
    const dutyAction = fn(row, rows) // fn 负责改 row 并返回要同步值班清单的动作（null 不同步）
    const inReview = REVIEW_STATUSES.includes(String(row.status))
    commitLinked(
      rows,
      row,
      actor,
      inReview ? { status: '待复核', pending: true } : null,
      inReview ? { status: '需整改', pending: true } : null,
      dutyAction,
    )
    return { ok: true, message: `处置单 ${row.处置编号} 已更新为「${row.status}」` }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : '操作失败' }
  }
}

// 派出处置：空值拦截（待测/中断都不许进处置中）+ 同点位在办判重
export function dispatchOrder(id: number, actor: Actor): ActionOutcome {
  return mutate(id, actor, (row, rows) => {
    if (row.status !== '待处置') throw new Error(`当前状态「${row.status}」不能派出处置`)
    const missing = missingBeforeDispatch(row)
    if (missing.length) {
      throw new Error(`处置单不能带空值进入处置中，缺项：\n${missing.join('；')}`)
    }
    const duplicate = rows.find(
      (other) =>
        Number(other.id) !== Number(row.id) &&
        other.点位编码 === row.点位编码 &&
        OPEN_STATUSES.includes(String(other.status)),
    )
    if (duplicate) {
      throw new Error(`同一渗漏点已有在办单 ${duplicate.处置编号}，重复派工只派出一次`)
    }
    row.status = '处置中'
    row.pending = true
    row.最后操作人 = actor.operator
    appendHistory(row, `派出处置（班组：${row.处置班组}，方式：${row.处置方式}）`)
    return '派出处置'
  })
}

export function completeOrder(id: number, actor: Actor): ActionOutcome {
  return mutate(id, actor, (row) => {
    if (row.status !== '处置中') throw new Error(`当前状态「${row.status}」不能确认完工`)
    row.status = '已完工'
    row.pending = false
    row.完工日期 = today()
    row.最后操作人 = actor.operator
    appendHistory(row, '确认完工')
    return '确认完工'
  })
}

// 要求返工：返工原因必填，同步检修待办 + 安防整改 + 值班清单
export function requestRework(id: number, reason: string, actor: Actor): ActionOutcome {
  const why = reason?.trim()
  if (!why) return { ok: false, message: '要求返工必须填写返工原因，原因为空已拒绝提交' }
  return mutate(id, actor, (row) => {
    if (!['处置中', '待复核'].includes(String(row.status))) {
      throw new Error(`当前状态「${row.status}」不能要求返工`)
    }
    row.status = '需返工'
    row.pending = true
    row.返工原因 = why
    row.返工时间 = today()
    row.最后操作人 = actor.operator
    appendHistory(row, `要求返工：${why}`)
    return '要求返工'
  })
}

// 重新采集（重试入口）：只重采上次没取到/中断的项，已实测项锁定不清空
export type RetakeInput = {
  flow?: number | null
  state: '已实测' | '待测（空态）' | '中断'
  reason?: string
  处置方式?: string
  处置班组?: string
}

export function retakeMeasurement(id: number, input: RetakeInput, actor: Actor): ActionOutcome {
  try {
    const rows = listRows(LEAK_KEY)
    const row = findLeak(rows, id)
    assertWritable(row, actor)
    if (!['待处置', '需返工'].includes(String(row.status))) {
      return { ok: false, message: `当前状态「${row.status}」不能重新采集` }
    }
    const wasMeasured = isMeasured(row)
    if (wasMeasured && input.state !== '已实测') {
      // 已实测项锁定：不允许用空态/中断覆盖既有实测值
      return { ok: false, message: '该单渗漏程度已有实测值并锁定，不能再改成空态/中断；两处取值打架以现场实测为准' }
    }
    if (input.state === '已实测') {
      if (typeof input.flow !== 'number' || Number.isNaN(input.flow) || input.flow < 0) {
        return { ok: false, message: '已实测必须带回非负实测流量（干裂缝为 0，空值不许记 0）' }
      }
      const graded = gradeByFlow(input.flow)
      row.实测流量 = input.flow
      row.渗漏程度 = graded.grade
      if (!String(row.处置方式 ?? '').trim() || input.处置方式) {
        row.处置方式 = input.处置方式?.trim() || graded.suggest
      }
      row.未测原因 = ''
      row.中断原因 = ''
    } else if (input.state === '中断') {
      if (!input.reason?.trim()) return { ok: false, message: '中断必须写明中断原因' }
      if (!wasMeasured) {
        row.实测流量 = ''
        row.渗漏程度 = ''
      }
      row.中断原因 = input.reason.trim()
      row.未测原因 = ''
    } else {
      if (!input.reason?.trim()) return { ok: false, message: '空态必须写明未测原因' }
      if (!wasMeasured) {
        row.实测流量 = ''
        row.渗漏程度 = ''
      }
      row.未测原因 = input.reason.trim()
      row.中断原因 = ''
    }
    row.程度状态 = input.state
    row.采集轮次 = Number(row.采集轮次 ?? 0) + 1
    if (input.处置班组?.trim()) row.处置班组 = input.处置班组.trim()
    if (input.state === '已实测') {
      row.来源标记 = '现场实测' // 历史补录缺项经重测转为现场实测，补录原值仍保留
    }
    row.最后操作人 = actor.operator
    appendHistory(row, `第 ${row.采集轮次} 轮采集：${input.state}${input.state === '已实测' ? `，流量 ${row.实测流量}，判级 ${row.渗漏程度}` : `，原因 ${input.reason ?? ''}`}`)
    saveRows(LEAK_KEY, rows)
    const stillMissing = missingBeforeDispatch(row)
    return {
      ok: true,
      message: stillMissing.length
        ? `第 ${row.采集轮次} 轮采集已记录，派工仍缺：${stillMissing.join('；')}`
        : `第 ${row.采集轮次} 轮采集完成，缺项已补齐，可以派出处置`,
    }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : '重新采集失败' }
  }
}

export function finishRework(id: number, actor: Actor): ActionOutcome {
  return mutate(id, actor, (row) => {
    if (row.status !== '需返工') throw new Error(`当前状态「${row.status}」不能申报返工完成`)
    if (!isMeasured(row)) throw new Error('返工后仍未实测渗漏程度，不能提交复核')
    row.status = '待复核'
    row.最后操作人 = actor.operator
    appendHistory(row, '返工完成，提交检修复核')
    return '返工完成'
  })
}

// 复核通过时两侧（检修待办、安防整改）同事务闭单，并同步值班清单
export function reviewPassAndClose(id: number, actor: Actor): ActionOutcome {
  try {
    const rows = listRows(LEAK_KEY)
    const row = findLeak(rows, id)
    assertWritable(row, actor)
    if (row.status !== '待复核') throw new Error(`当前状态「${row.status}」不能复核通过`)
    row.status = '已完工'
    row.pending = false
    row.完工日期 = today()
    row.最后操作人 = actor.operator
    appendHistory(row, '复核通过，返工闭环')

    let maintenance = listRows(MAIN_KEY)
    let access = listRows(ACCESS_KEY)
    maintenance = upsertReviewTodo(maintenance, row, actor, { status: '已完工', pending: false, note: '复核通过，闭环' })
    access = upsertAccessLink(access, row, actor, { status: '状态正常', pending: false })
    let duty = listRows(DUTY_KEY)
    duty = appendDutyEvent(duty, row, '复核通过', actor)

    const reviewOpen = maintenance.some((r) => r.联动处置单 === row.处置编号 && r.status === '待复核')
    const accessOpen = access.some((r) => r.联动处置单 === row.处置编号 && r.status === '需整改')
    if (reviewOpen || accessOpen) {
      throw new Error('联动闭单被拒绝：检修待办与安防台账条数未对齐，已整批回滚')
    }
    const idx = rows.findIndex((item) => Number(item.id) === Number(row.id))
    saveRows(LEAK_KEY, [...rows.slice(0, idx), row, ...rows.slice(idx + 1)])
    saveRows(MAIN_KEY, maintenance)
    saveRows(ACCESS_KEY, access)
    saveRows(DUTY_KEY, duty)
    return { ok: true, message: `处置单 ${row.处置编号} 复核闭环，检修待办与安防整改已同步关闭` }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : '复核失败' }
  }
}

export function reviewReject(id: number, reason: string, actor: Actor): ActionOutcome {
  const why = reason?.trim()
  if (!why) return { ok: false, message: '复核不通过必须填写原因' }
  return mutate(id, actor, (row) => {
    if (row.status !== '待复核') throw new Error(`当前状态「${row.status}」不能退回返工`)
    row.status = '需返工'
    row.pending = true
    row.最后操作人 = actor.operator
    appendHistory(row, `复核不通过：${why}`)
    return '复核不通过'
  })
}

// ---- 存量/老记录：按业务发生日整批补录，缺项单独标注来源 ----
export type BackfillResult = { processed: number; skipped: number; batch: string; messages: string[] }

export function backfillLegacy(actor: Actor): BackfillResult {
  const rows = listRows(LEAK_KEY)
  const batch = `BF-${today().replace(/-/g, '')}-01`
  let processed = 0
  const messages: string[] = []
  const next = rows.map((row) => {
    const isLegacy = String(row.来源标记 ?? '').includes('历史补录')
    const tagged = String(row.来源标记 ?? '').includes('补录缺项')
    if (!isLegacy || tagged) return row
    const updated: EntryRow = { ...row }
    updated.补录批次 = batch
    updated.补录原值 = String(row.渗漏点位 ?? '') // 原纸质档案仅有的"渗漏部位"原文封存
    if (!isMeasured(row) && !row.渗漏程度) {
      updated.渗漏程度 = ''
      updated.实测流量 = ''
      updated.程度状态 = '待测（空态）'
      updated.未测原因 = HISTORY_REASON
      updated.采集轮次 = 0
      updated.来源标记 = '历史补录·补录缺项'
      messages.push(`${row.处置编号}：程度按"历史缺记待测"口径补标，派工前须现场重采`)
    } else {
      updated.来源标记 = '历史补录·程度有据'
      messages.push(`${row.处置编号}：原档有程度记载，保留原值并标注历史补录来源`)
    }
    if (!updated.点位编码) {
      updated.点位编码 = normalizePointCode(String(row.渗漏点位 ?? '')) ?? ''
      if (!updated.点位编码) messages.push(`${row.处置编号}：点位描述无法规范化编码，先补点位再派工`)
    }
    updated.最后操作人 = actor.operator
    appendHistory(updated, `历史补录批次 ${batch}（按发现日期 ${row.发现日期} 回填，非补录操作日）`)
    processed += 1
    return updated
  })
  saveRows(LEAK_KEY, next)
  return { processed, skipped: rows.length - processed, batch, messages }
}

// ---- 联动对账：检修待复核条数 vs 安防需整改条数，值班清单同源校验 ----
export type ReconcileReport = {
  reviewKeys: string[]
  accessKeys: string[]
  missingInAccess: string[]
  staleInAccess: string[]
  consistent: boolean
  dutyEvents: number
}

export function reconcile(): ReconcileReport {
  const leaks = listRows(LEAK_KEY)
  const reviewKeys = leaks
    .filter((row) => REVIEW_STATUSES.includes(String(row.status)))
    .map((row) => String(row.处置编号))
  const maintenance = listRows(MAIN_KEY)
  const access = listRows(ACCESS_KEY)
  const reviewOpenKeys = maintenance
    .filter((row) => row.来源 === '渗漏联动' && row.status === '待复核')
    .map((row) => String(row.联动处置单))
  const accessKeys = access
    .filter((row) => row.来源 === '渗漏联动' && row.status === '需整改')
    .map((row) => String(row.联动处置单))
  const missingInAccess = reviewOpenKeys.filter((key) => !accessKeys.includes(key))
  const staleInAccess = accessKeys.filter((key) => !reviewOpenKeys.includes(key))
  const dutyEvents = listRows(DUTY_KEY).reduce(
    (sum, row) => sum + String(row.交接事项 ?? '').split('\n').filter((l) => l.includes('[渗漏联动]')).length,
    0,
  )
  return {
    reviewKeys,
    accessKeys,
    missingInAccess,
    staleInAccess,
    consistent: missingInAccess.length === 0 && staleInAccess.length === 0,
    dutyEvents,
  }
}

export function leakStats(rows: EntryRow[]) {
  const month = today().slice(0, 7)
  return [
    { label: '待处置渗漏点', value: rows.filter((r) => r.status === '待处置').length },
    { label: '处置中渗漏点', value: rows.filter((r) => r.status === '处置中').length },
    { label: '待测/中断数', value: rows.filter((r) => ['待测（空态）', '中断'].includes(String(r.程度状态)) && r.status !== '已完工').length },
    { label: '返工待复核', value: rows.filter((r) => REVIEW_STATUSES.includes(String(r.status))).length },
    { label: '本月完工数', value: rows.filter((r) => r.status === '已完工' && String(r.完工日期 ?? '').startsWith(month)).length },
  ]
}
