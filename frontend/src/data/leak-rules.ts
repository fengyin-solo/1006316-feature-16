/**
 * 渗漏水处置的业务口径集中在这里：状态、空态、取值映射、判重、必填校验都是纯函数，
 * 页面与 local-service 都不自己判业务，换成后端时这份口径可以直接对照成接口校验。
 */

export type Actor = {
  operator: string
  unit: string
  post: string
}

// 处置单状态机
export const LEAK_STATUSES = ['待处置', '处置中', '已完工', '需返工'] as const
/** 仍占着同一个渗漏点、没有闭环的状态：判重只看这些状态的单。 */
export const ACTIVE_STATUSES = ['待处置', '处置中', '需返工'] as const

// 渗漏程度的空态：取不到不是 0，必须区分「还没测」和「测到一半被打断」。
export const DEGREE_MEASURED = '已实测'
export const DEGREE_PENDING = '待测'
export const DEGREE_INTERRUPTED = '测取中断'
export const DEGREE_STATES = [DEGREE_MEASURED, DEGREE_PENDING, DEGREE_INTERRUPTED] as const

/** 现场实测可选值：干裂缝（无出水）与真出水在第一档就分开，避免班组到场才发现。 */
export const DEGREE_OPTIONS = ['干裂缝（无出水）', '面渗（湿渍）', '滴漏', '线漏', '涌水'] as const

/**
 * 渗漏等级与处置方式都是现场实测值的派生项。
 * 两处取值打架时以现场实测为准，等级和处置方式按这张表整体重算。
 */
const DEGREE_DERIVED: Record<string, DerivedDegree> = {
  '干裂缝（无出水）': { level: '轻微', method: '表面封闭、嵌缝观察' },
  '面渗（湿渍）': { level: '一般', method: '渗透结晶涂层封闭' },
  滴漏: { level: '较重', method: '注浆止水加嵌缝封堵' },
  线漏: { level: '严重', method: '引流注浆加速凝封堵' },
  涌水: { level: '严重', method: '应急引流加结构注浆，立即上报' },
}

export type DerivedDegree = { level: string; method: string }

export function deriveByDegree(degree: string): DerivedDegree {
  return DEGREE_DERIVED[degree] ?? { level: '', method: '' }
}

/** 空值判断：没有数据就是没有数据，任何地方都不许把它当成 0。 */
export function isBlank(value: unknown): boolean {
  return value === undefined || value === null || String(value).trim() === ''
}

/**
 * 判重口径（统一按这一个字段组合判，页面与服务都不许另立口径）：
 * key = 所属舱室 + 渗漏点位，各自去首尾空白并去掉内部空白后拼接。
 * 同一渗漏点在存在未闭环处置单期间，只派一次工；已完工后再次渗漏算新事件。
 */
export function leakPointKey(cabin: string, point: string): string {
  const norm = (text: string) => String(text ?? '').trim().replace(/\s+/g, '')
  return `${norm(cabin)}|${norm(point)}`
}

export function rowPointKey(row: { [field: string]: unknown }): string {
  return leakPointKey(String(row['所属舱室'] ?? ''), String(row['渗漏点位'] ?? ''))
}

export function isActive(status: unknown): boolean {
  return (ACTIVE_STATUSES as readonly string[]).includes(String(status))
}

export function degreeMeasured(row: { [field: string]: unknown }): boolean {
  return String(row['程度状态'] ?? '') === DEGREE_MEASURED && !isBlank(row['渗漏程度'])
}

/** 进入「处置中」之前的必填闸口：渗漏程度空着一律拦下，待处置单可以先登记但不能派出。 */
export function dispatchBlockers(row: { [field: string]: unknown }): string[] {
  const blockers: string[] = []
  if (isBlank(row['渗漏点位'])) blockers.push('渗漏点位')
  if (!degreeMeasured(row)) blockers.push('渗漏程度（现场实测）')
  if (isBlank(row['处置班组'])) blockers.push('处置班组')
  return blockers
}

export function todayString(): string {
  const now = new Date()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}
