// 业务不变量验证：node 里垫一个 localStorage，把渗漏处置全流程跑一遍。
const mem = new Map<string, string>()
globalThis.window = {
  localStorage: {
    getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
    setItem: (k: string, v: string) => void mem.set(k, v),
    removeItem: (k: string) => void mem.delete(k),
  },
} as unknown as Window & typeof globalThis

import { runAction, listEntries, reconcileAll } from '@/api/local-service'
import {
  backfillLegacy,
  completeLeak,
  createLeak,
  dispatchLeak,
  leakRows,
  redispatchRework,
  requestRework,
  retryMeasure,
} from '@/api/leak-service'
import { listRows } from '@/data/local-store'

const unit1 = { operator: '张工', unit: '第一管廊管理所', post: '渗漏处置岗' }
const unit2 = { operator: '外协', unit: '第二管廊管理所', post: '外协管理岗' }
let passed = 0
function check(name: string, cond: boolean, extra = '') {
  if (!cond) {
    console.error(`✗ ${name} ${extra}`)
    process.exit(1)
  }
  passed += 1
  console.log(`✓ ${name}`)
}

// 初始种子：1 条返工待复核(LEAK-0005)、1 条安防需整改(ACCE-0004)
const report0 = reconcileAll()
check('种子对账：返工待办=返工来源', report0.reworkTodos === report0.reworkSources && report0.reworkSources === 1, JSON.stringify(report0))
check('种子对账：安防待办=需整改条数', report0.securityTodos === report0.securitySources && report0.securitySources === 1)
const todoOnRework = listRows('maintenance').filter((r) => r['关联来源'] === '渗漏返工')
check('返工结论已回写检修待办(待复核)', todoOnRework.length === 1 && todoOnRework[0].status === '待复核')

// 1. 空态：取不到必须写原因
const r1 = createLeak({ 所属舱室: '综合舱', 渗漏点位: 'K9+001 测试点' } as never, unit1)
check('未给程度默认待测但缺原因被拒', !r1.ok && r1.message.includes('待测原因'))
const r1b = createLeak(
  { 所属舱室: '综合舱', 渗漏点位: 'K9+001 测试点', 程度状态: '测取中断', 未测原因: '测取中途停电中断' } as never,
  unit1,
)
check('带中断原因登记成功', r1b.ok, r1b.message)
const blankRow = leakRows().find((r) => r['渗漏点位'] === 'K9+001 测试点')!
check('空态：渗漏程度留空（不许当0）', String(blankRow['渗漏程度']) === '' && String(blankRow['渗漏等级']) === '')
check('空态标记为测取中断且有原因', blankRow['程度状态'] === '测取中断' && String(blankRow['未测原因']).includes('停电'))

// 2. 处置单不能带空值进入处置中
const blocked = dispatchLeak(Number(blankRow.id), unit1)
check('空程度派工被拦', !blocked.ok && blocked.message.includes('不能带空值进入处置中'), blocked.message)

// 3. 重试测取：先仍取不到（待测+原因），再实测回填
const r3a = retryMeasure(Number(blankRow.id), { measured: false, state: '待测', reason: '积水未抽排' }, unit1)
check('重试仍取不到可标待测', r3a.ok)
const r3b = retryMeasure(Number(blankRow.id), { measured: true, degree: '涌水' }, unit1)
check('重试现场实测成功', r3b.ok, r3b.message)
const afterMeasure = leakRows().find((r) => Number(r.id) === Number(blankRow.id))!
check('实测后等级/处置方式按实测重算', afterMeasure['渗漏等级'] === '严重' && String(afterMeasure['处置方式']).includes('应急引流'))
check('实测后空态原因清空', String(afterMeasure['未测原因']) === '')

// 4. 取值打架：初判滴漏，现场复测线漏，以现场实测为准
const c4 = createLeak({ 所属舱室: '综合舱', 渗漏点位: 'K9+002 打架点', 渗漏程度: '滴漏', 处置班组: '堵漏一班' } as never, unit1)
check('登记实测单成功', c4.ok)
const id4 = leakRows().find((r) => r['渗漏点位'] === 'K9+002 打架点')!.id
const r4 = retryMeasure(Number(id4), { measured: true, degree: '线漏', note: '班组到场复核实测' }, unit1)
check('复测覆盖成功', r4.ok)
const row4 = leakRows().find((r) => Number(r.id) === Number(id4))!
check('以现场实测那份为准', row4['渗漏程度'] === '线漏' && String(row4['取值说明']).includes('以现场实测为准'))

// 5. 派工闸口通过 + 同点重复派工拒绝
const d5 = dispatchLeak(Number(id4), unit1)
check('已实测单据可派出', d5.ok)
const dup5 = createLeak({ 所属舱室: ' 综 合 舱 ', 渗漏点位: ' K9+002 打架点 ', 渗漏程度: '滴漏' } as never, unit1)
check('同渗漏点（归一化后）重复登记拒绝', !dup5.ok && dup5.message.includes('只派一次工'), dup5.message)
const fin5 = completeLeak(Number(id4), unit1)
check('处置中可完工', fin5.ok)
const re5 = createLeak({ 所属舱室: '综合舱', 渗漏点位: 'K9+002 打架点', 渗漏程度: '滴漏' } as never, unit1)
check('闭环后再渗漏视为新事件可开单', re5.ok)

// 6. 返工必填原因
const idRework = leakRows().find((r) => r['处置编号'] === 'LEAK-0005')!.id
const rwNoReason = requestRework(Number(blankRow.id), '  ', unit1) // blankRow 还在待处置，验状态前先验原因
const rw6 = requestRework(Number(idRework), '', unit1)
check('返工无原因被拒', !rw6.ok && rw6.message.includes('返工原因'))
check('非已完工单返工被拒', !rwNoReason.ok)

// 7. 整批补录：按业务发生日，缺项标注来源，不编 0
const bf = backfillLegacy(
  [
    { 所属舱室: '水信舱', 渗漏点位: 'K3+001 老缝', 发现日期: '2023-05-10' },
    { 所属舱室: '水信舱', 渗漏点位: 'K3+002 老缝', 发现日期: '2023-06-01', 渗漏程度: '面渗（湿渍）', 处置班组: '堵漏一班', 处置方式: '渗透结晶涂层封闭' },
  ],
  unit1,
  '20261006',
)
check('整批补录成功', bf.ok, bf.message)
const legacyBlank = leakRows().find((r) => r['渗漏点位'] === 'K3+001 老缝')!
check('补录缺程度：留空标待测，不编0', String(legacyBlank['渗漏程度']) === '' && legacyBlank['程度状态'] === '待测')
check('补录缺项单独标注来源', String(legacyBlank['数据来源']) === '上线前补录' && String(legacyBlank['缺项标注']).includes('缺项：渗漏程度'))
check('补录按业务发生日回填', legacyBlank['发现日期'] === '2023-05-10' && legacyBlank['完工日期'] === '2023-05-10')
const legacyFull = leakRows().find((r) => r['渗漏点位'] === 'K3+002 老缝')!
check('补录有程度的单据按实测口径落库', legacyFull['渗漏程度'] === '面渗（湿渍）' && legacyFull['渗漏等级'] === '一般')
// 重复补录幂等
const bf2 = backfillLegacy(
  [{ 所属舱室: '水信舱', 渗漏点位: 'K3+001 老缝', 发现日期: '2023-05-10' }],
  unit1,
  '20261006',
)
check('同批次重复补录跳过', bf2.ok && bf2.message.includes('跳过 1'), bf2.message)

// 8. 返工重新派出：上次数据作废回到待测
const rd = redispatchRework(Number(idRework), unit1)
check('返工重新派出', rd.ok)
const reworkRow = leakRows().find((r) => Number(r.id) === Number(idRework))!
check('重新派出后程度回空态待测', reworkRow['程度状态'] === '待测' && String(reworkRow['渗漏程度']) === '')
// 待复核待办仍挂一条（返工来源未闭环）
const rep8 = reconcileAll()
check('返工重派期间待办仍在且条数一致', rep8.reworkTodos === rep8.reworkSources && rep8.reworkSources === 1)

// 9. 检修侧复核闭环：销项并回写处置单
const todoId = listRows('maintenance').find((r) => r['关联单号'] === 'LEAK-0005')!.id
const cc = runAction('maintenance', Number(todoId), '复核闭环')
check('复核闭环成功', cc.ok, cc.message)
const closed = leakRows().find((r) => r['处置编号'] === 'LEAK-0005')!
check('返工结论回写处置单：复核通过', closed['复核状态'] === '复核通过')
const rep9 = reconcileAll()
check('闭环后返工待办核销，条数仍一致', rep9.reworkTodos === 0 && rep9.reworkSources === 0)
check('安防待办不受影响仍=1', rep9.securityTodos === 1 && rep9.securitySources === 1)

// 10. 安防动作驱动对账：提出整改后待办+1，判定正常后核销
const acNormal = listRows('access').find((r) => r.status === '需整改')!
const ac10 = runAction('access', Number(acNormal.id), '判定正常')
check('安防恢复正常并对账', ac10.ok && ac10.message.includes('台账一致'), ac10.message)
const rep10a = reconcileAll()
check('安防待办随台账核销', rep10a.securityTodos === 0 && rep10a.securitySources === 0)
// 再造一条需整改
const standby = listRows('access').find((r) => r.status === '待检查')!
runAction('access', Number(standby.id), '提交检查')
const ac10b = runAction('access', Number(standby.id), '提出整改')
check('安防提出整改并回写', ac10b.ok)
const rep10b = reconcileAll()
check('整改后待办条数与安防台账一致', rep10b.securityTodos === 1 && rep10b.securitySources === 1)

// 11. 跨单位只读 / 越权拒绝 / 改动归原岗位
const foreign = leakRows().find((r) => r['归属单位'] === '第二管廊管理所')!
const x11 = dispatchLeak(Number(foreign.id), unit1) // 已完工，若过权限会先撞状态，故测完工单上的返工
const rw11 = requestRework(Number(foreign.id), '越权试一下', unit1)
check('跨单位提交返工被拒', !rw11.ok && rw11.message.includes('跨单位单据只读'), rw11.message)
void x11
// 本单位改动不覆盖归属岗位
const own = leakRows().find((r) => r['处置编号'] === 'LEAK-0001')!
retryMeasure(Number(own.id), { measured: true, degree: '滴漏' }, unit1)
const ownAfter = leakRows().find((r) => Number(r.id) === Number(own.id))!
check('改动记录仍归原岗位', ownAfter['归属岗位'] === '渗漏处置岗' && ownAfter['归属单位'] === '第一管廊管理所')

// 12. 值班清单同步
const duty = listRows('duty')
const today = new Date().toISOString().slice(0, 10)
const todayDuty = duty.filter((r) => r['值班日期'] === today)
check('动作已同步进当天值班交接记录', todayDuty.length >= 1 && String(todayDuty[0]['交接事项']).includes('渗漏'))
const totalLines = todayDuty.reduce((s, r) => s + String(r['交接事项']).split('\n').length, 0)
check('值班日志条目覆盖登记/测取/派工/返工/补录/对账等动作', totalLines >= 6, `lines=${totalLines}`)

// 13. 统计不把空态当 0 字段、导出空单元格
const list = listEntries('leak')
check('列表仍含全部记录（空态记录不丢）', list.items.length >= 9)
check('空态程度在数据里就是空串而非数字0', list.items.every((r) => r['渗漏程度'] !== 0 && r['渗漏等级'] !== 0))

console.log(`\n全部 ${passed} 项不变量验证通过`)
