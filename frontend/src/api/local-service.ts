import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveRows } from '@/data/local-store'
import type { ActionResult, Actor, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'
import { closeReviewByTodo, reconcileTodos } from '@/api/leak-service'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

// 各模块的终态：不在终态里就是待办，不能再简单拿状态数组最后一个判断。
const TERMINAL_STATUSES: Record<string, string[]> = {
  maintenance: ['已完工', '已延期'],
}

// 当前操作人默认是值班管理员，页面挂载时用会话里的单位/岗位同步，跨单位只读靠它判定。
let current: Actor = { operator: '值班管理员', unit: '第一管廊管理所', post: '渗漏处置岗' }

export function setCurrentActor(actor: Actor): void {
  current = actor
}

function currentActor(): Actor {
  return current
}

/** 跨单位只读：记录带归属单位且与当前岗位单位不一致时，任何提交一律拒绝。 */
function assertWritable(row: EntryRow, meta: ModuleMeta): ActionResult | null {
  const owner = String(row['归属单位'] ?? '').trim()
  if (owner && owner !== currentActor().unit) {
    return { ok: false, message: `越权提交被拒绝：${meta.entity} ${owner} 的记录对本单位只读，改动仍归原岗位` }
  }
  return null
}

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }

  // 渗漏返工待办的「复核闭环」必须回写处置单并对账，不能走通用状态覆盖。
  if (key === 'maintenance' && action === '复核闭环') {
    return closeReviewByTodo(id, currentActor())
  }

  // 回写生成的待办只能在渗漏/安防流程里核销：通用页面不允许直接改它们的状态。
  const linked = String(rows[index]['关联来源'] ?? '')
  if (key === 'maintenance' && linked && action !== '复核闭环') {
    return { ok: false, message: `该记录是「${linked}」回写的待复核待办，请在对应业务流程中复核闭环` }
  }

  const denied = assertWritable(rows[index], meta)
  if (denied) {
    return denied
  }

  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const terminal = TERMINAL_STATUSES[key] ?? [meta.statuses[meta.statuses.length - 1]]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: !terminal.includes(target),
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)

  // 安防状态流转后立刻对账：整改动作回写后的待办条数必须与安防台账「需整改」一致。
  if (key === 'access') {
    const report = reconcileTodos(currentActor())
    const balanced = report.balanced ? '待办条数与台账一致' : '待办对账出现差异'
    return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」；${balanced}` }
  }
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

/** 进入页面时也跑一遍对账：任何来源产生过的回写差异都能自愈，待办条数始终等于来源条数。 */
export function reconcileAll(): {
  reworkTodos: number
  reworkSources: number
  securityTodos: number
  securitySources: number
  balanced: boolean
} {
  return reconcileTodos(currentActor())
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
