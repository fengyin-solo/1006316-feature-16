<template>
  <section class="page" data-module="leak">
    <header class="page-head">
      <div>
        <h2>渗漏水处置管理</h2>
        <p class="page-desc">
          渗漏程度取不到时留空态（待测 / 测取中断）并写明原因，空值不许当成 0；处置单不能带空值进入处置中；
          要求返工必填返工原因，重试入口重新取数，取值打架以现场实测为准并重算。
          判重口径：<strong>所属舱室 + 渗漏点位</strong>，同一渗漏点未闭环期间只派一次工。
        </p>
      </div>
      <div class="page-actions">
        <label class="unit-switch">
          当前单位
          <select :value="session.unit" @change="switchUnit(($event.target as HTMLSelectElement).value)">
            <option v-for="unit in units" :key="unit" :value="unit">{{ unit }}</option>
          </select>
        </label>
        <button class="btn primary" type="button" @click="openCreate">登记渗漏处置单</button>
        <button class="btn" type="button" @click="openBackfill">整批补录老记录</button>
        <button class="btn" type="button" @click="exportRows">导出清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in statCards" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="reconcile-bar" :class="{ warn: !reconcile.balanced }">
      回写一致性：返工待复核待办 {{ reconcile.reworkTodos }} 条 = 返工来源 {{ reconcile.reworkSources }} 条；
      安防整改待办 {{ reconcile.securityTodos }} 条 = 安防台账「需整改」{{ reconcile.securitySources }} 条；
      值班台账随动作同步更新。
    </p>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
      <span class="legend-item">
        渗漏程度待测量（空态，不计 0）：{{ summary.unmeasured }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label class="filter-item">
        <span>所属舱室/点位</span>
        <input v-model="filters.keyword" placeholder="按舱室或渗漏点位检索" />
      </label>
      <label class="filter-item">
        <span>处置状态</span>
        <select v-model="filters.status">
          <option value="">全部</option>
          <option v-for="status in statuses" :key="status" :value="status">{{ status }}</option>
        </select>
      </label>
      <label class="filter-item">
        <span>程度状态</span>
        <select v-model="filters.degreeState">
          <option value="">全部</option>
          <option value="已实测">已实测</option>
          <option value="待测">待测</option>
          <option value="测取中断">测取中断</option>
        </select>
      </label>
      <label class="filter-item">
        <span>数据来源</span>
        <select v-model="filters.source">
          <option value="">全部</option>
          <option value="运行期登记">运行期登记</option>
          <option value="上线前补录">上线前补录</option>
        </select>
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)" :class="{ readonly: !writable(row) }">
          <td v-for="column in columns" :key="column">
            <template v-if="column === '渗漏程度'">
              <span v-if="blank(row[column])" class="blank-tag">{{ row['程度状态'] }}</span>
              <template v-else>{{ row[column] }}</template>
            </template>
            <template v-else-if="column === '程度状态'">
              <span class="degree-tag" :class="degreeClass(row)">{{ row[column] }}</span>
            </template>
            <template v-else-if="column === '返工原因'">
              <span v-if="blank(row[column])" class="muted">—</span>
              <span v-else :title="String(row[column])">{{ short(row[column]) }}</span>
            </template>
            <template v-else-if="column === '未测原因'">
              <span v-if="blank(row[column])" class="muted">—</span>
              <span v-else :title="String(row[column])" class="reason-text">{{ short(row[column]) }}</span>
            </template>
            <template v-else>{{ row[column] ?? '' }}</template>
          </td>
          <td>
            {{ row.status }}
            <span v-if="!writable(row)" class="lock-tag">跨单位只读</span>
          </td>
          <td class="row-actions">
            <template v-if="writable(row)">
              <button
                v-if="row.status === '待处置'"
                class="link"
                type="button"
                @click="dispatch(row)"
              >派出处置</button>
              <button
                v-if="row.status === '待处置' || row.status === '需返工'"
                class="link"
                type="button"
                @click="openMeasure(row)"
              >{{ row['程度状态'] === '已实测' ? '复测回填' : '重试测取' }}</button>
              <button
                v-if="row.status === '处置中'"
                class="link"
                type="button"
                @click="complete(row)"
              >确认完工</button>
              <button
                v-if="row.status === '已完工'"
                class="link danger"
                type="button"
                @click="openRework(row)"
              >要求返工</button>
              <button
                v-if="row.status === '需返工'"
                class="link"
                type="button"
                @click="redispatch(row)"
              >返工重新派出</button>
            </template>
            <span v-else class="muted">仅可查看</span>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无符合条件的渗漏水处置记录</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条渗漏水处置记录</span>
      <span v-if="message" class="error-text">{{ message }}</span>
    </footer>

    <!-- 登记处置单 -->
    <div v-if="createOpen" class="modal-mask" @click.self="createOpen = false">
      <form class="modal" @submit.prevent="submitCreate">
        <h3>登记渗漏处置单</h3>
        <p class="modal-tip">渗漏点位必填。渗漏程度允许先取不到：选空态并写明原因，派工前必须经现场实测回填。</p>
        <label class="form-item"><span>所属舱室 *</span><input v-model="createForm.cabin" placeholder="如 综合舱" /></label>
        <label class="form-item"><span>渗漏点位 *</span><input v-model="createForm.point" placeholder="如 K0+200 顶板施工缝" /></label>
        <label class="form-item"><span>处置班组</span><input v-model="createForm.team" placeholder="未确定可留空，派工前补齐" /></label>
        <label class="form-item"><span>发现日期</span><input v-model="createForm.foundDate" type="date" /></label>
        <fieldset class="form-block">
          <legend>渗漏程度</legend>
          <label class="radio-line">
            <input v-model="createForm.mode" type="radio" value="measured" /> 现场已实测
            <select v-model="createForm.degree" :disabled="createForm.mode !== 'measured'">
              <option value="" disabled>选择实测程度</option>
              <option v-for="option in degreeOptions" :key="option" :value="option">{{ option }}</option>
            </select>
          </label>
          <label class="radio-line">
            <input v-model="createForm.mode" type="radio" value="待测" /> 待测（原因必填）
          </label>
          <label class="radio-line">
            <input v-model="createForm.mode" type="radio" value="测取中断" /> 测取中断（原因必填）
          </label>
          <textarea
            v-if="createForm.mode !== 'measured'"
            v-model="createForm.reason"
            rows="2"
            :placeholder="createForm.mode === '待测' ? '待测原因，如：积水未抽排，仪器无法贴近作业面' : '中断原因，如：测取中途遇停电，作业被迫中止'"
          ></textarea>
        </fieldset>
        <p v-if="modalError" class="error-text">{{ modalError }}</p>
        <div class="modal-actions">
          <button class="btn" type="button" @click="createOpen = false">取消</button>
          <button class="btn primary" type="submit">提交登记</button>
        </div>
      </form>
    </div>

    <!-- 重试测取 / 现场回填 -->
    <div v-if="measureOpen" class="modal-mask" @click.self="measureOpen = false">
      <form class="modal" @submit.prevent="submitMeasure">
        <h3>{{ measureTarget?.['程度状态'] === '已实测' ? '复测回填' : '重试测取' }} · {{ measureTarget?.['处置编号'] }}</h3>
        <p class="modal-tip">重试会把上一次没取到的数据重新取一遍。两次取值打架时以本次现场实测为准，等级与处置方式自动重算。</p>
        <label class="radio-line">
          <input v-model="measureForm.mode" type="radio" value="measured" /> 本次现场实测
          <select v-model="measureForm.degree" :disabled="measureForm.mode !== 'measured'">
            <option value="" disabled>选择实测程度</option>
            <option v-for="option in degreeOptions" :key="option" :value="option">{{ option }}</option>
          </select>
        </label>
        <label class="radio-line"><input v-model="measureForm.mode" type="radio" value="待测" /> 仍取不到，标待测</label>
        <label class="radio-line"><input v-model="measureForm.mode" type="radio" value="测取中断" /> 测取中断</label>
        <textarea
          v-if="measureForm.mode !== 'measured'"
          v-model="measureForm.reason"
          rows="2"
          placeholder="空态原因必填：待测写清卡在哪一步，中断写清被什么打断"
        ></textarea>
        <p v-if="modalError" class="error-text">{{ modalError }}</p>
        <div class="modal-actions">
          <button class="btn" type="button" @click="measureOpen = false">取消</button>
          <button class="btn primary" type="submit">保存取值</button>
        </div>
      </form>
    </div>

    <!-- 要求返工 -->
    <div v-if="reworkOpen" class="modal-mask" @click.self="reworkOpen = false">
      <form class="modal" @submit.prevent="submitRework">
        <h3>要求返工 · {{ reworkTarget?.['处置编号'] }}</h3>
        <p class="modal-tip">返工原因必填，提交后返工结论回写设施检修管理待办（待复核），一条返工对应一条待办。</p>
        <textarea v-model="reworkReason" rows="4" placeholder="返工原因：现场看到的出水/封堵质量问题、复检依据"></textarea>
        <p v-if="modalError" class="error-text">{{ modalError }}</p>
        <div class="modal-actions">
          <button class="btn" type="button" @click="reworkOpen = false">取消</button>
          <button class="btn primary" type="submit">提交返工</button>
        </div>
      </form>
    </div>

    <!-- 整批补录 -->
    <div v-if="backfillOpen" class="modal-mask" @click.self="backfillOpen = false">
      <form class="modal wide" @submit.prevent="submitBackfill">
        <h3>上线前老记录整批补录</h3>
        <p class="modal-tip">
          每行一条，按业务发生日（发现日期）补录，CSV 列：所属舱室,渗漏点位,发现日期,渗漏程度,处置班组,处置方式。
          早年只记了渗漏部位的，渗漏程度留空即可，系统标「待测」并在缺项标注里单独注明来源，绝不编造成 0。
        </p>
        <textarea v-model="backfillText" rows="8" placeholder="综合舱,K0+060 顶板纵向裂缝,2025-03-12,,,,&#10;电力舱,K0+930 侧墙裂缝,2024-11-02,滴漏,堵漏一班,注浆止水"></textarea>
        <p v-if="modalError" class="error-text">{{ modalError }}</p>
        <div class="modal-actions">
          <button class="btn" type="button" @click="backfillOpen = false">取消</button>
          <button class="btn primary" type="submit">整批补录</button>
        </div>
      </form>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  reconcileAll,
} from '@/api/local-service'
import {
  backfillLegacy,
  completeLeak,
  createLeak,
  dispatchLeak,
  leakStats,
  redispatchRework,
  requestRework,
  retryMeasure,
} from '@/api/leak-service'
import {
  DEGREE_INTERRUPTED,
  DEGREE_MEASURED,
  DEGREE_PENDING,
} from '@/data/leak-rules'
import type { EntryRow } from '@/data/types'
import { UNITS, useSessionStore } from '@/stores/session'

const meta = moduleMeta('leak')
const session = useSessionStore()
const units = UNITS

const columns = [
  '处置编号', '所属舱室', '渗漏点位', '渗漏程度', '程度状态', '渗漏等级',
  '处置方式', '处置班组', '发现日期', '完工日期', '返工原因', '未测原因',
  '取值说明', '复核状态', '数据来源', '缺项标注', '归属单位', '归属岗位',
]
const statuses = ['待处置', '处置中', '已完工', '需返工']
const degreeOptions = ['干裂缝（无出水）', '面渗（湿渍）', '滴漏', '线漏', '涌水']

const rows = ref<EntryRow[]>([])
const total = ref(0)
const message = ref('')
const modalError = ref('')
const filters = reactive({ keyword: '', status: '', degreeState: '', source: '' })
const reconcile = reactive({ reworkTodos: 0, reworkSources: 0, securityTodos: 0, securitySources: 0, balanced: true })

const summary = computed(() => leakStats(rows.value))
const statCards = computed(() => [
  { label: '待处置渗漏点', value: summary.value.waiting },
  { label: '处置中渗漏点', value: summary.value.working },
  { label: '需返工处置单', value: summary.value.rework },
  { label: '渗漏程度待测量（空态）', value: summary.value.unmeasured },
  { label: '本月完工数', value: summary.value.finishedThisMonth },
])
const statusSummary = computed(() =>
  statuses.map((status) => ({ status, count: rows.value.filter((row) => String(row.status) === status).length })),
)

function actor() {
  return { operator: session.operator, unit: session.unit, post: session.post }
}

function blank(value: unknown): boolean {
  return value === undefined || value === null || String(value).trim() === ''
}

function writable(row: EntryRow): boolean {
  const owner = String(row['归属单位'] ?? '').trim()
  return owner === '' || owner === session.unit
}

function degreeClass(row: EntryRow): string {
  const state = String(row['程度状态'] ?? '')
  if (state === DEGREE_MEASURED) return 'measured'
  if (state === DEGREE_INTERRUPTED) return 'interrupted'
  return 'pending'
}

function short(value: unknown): string {
  const text = String(value ?? '')
  return text.length > 18 ? `${text.slice(0, 18)}…` : text
}

function switchUnit(unit: string) {
  session.setUnit(unit)
  message.value = `已切换到${unit}：其他单位的处置单只读，越权提交会被拒绝`
  reload()
}

function resetFilters() {
  filters.keyword = ''
  filters.status = ''
  filters.degreeState = ''
  filters.source = ''
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function refreshReconcile() {
  const report = reconcileAll()
  Object.assign(reconcile, report)
}

function reload() {
  message.value = ''
  refreshReconcile()
  const all = listEntries(meta.key).items
  rows.value = all.filter((row) => {
    const keyword = filters.keyword.trim()
    if (keyword) {
      const haystack = `${String(row['所属舱室'] ?? '')}${String(row['渗漏点位'] ?? '')}`
      if (!haystack.includes(keyword)) {
        return false
      }
    }
    if (filters.status && String(row.status) !== filters.status) {
      return false
    }
    if (filters.degreeState && String(row['程度状态'] ?? '') !== filters.degreeState) {
      return false
    }
    if (filters.source && String(row['数据来源'] ?? '') !== filters.source) {
      return false
    }
    return true
  })
  total.value = rows.value.length
}

function announce(result: { ok: boolean; message: string }) {
  if (!result.ok) {
    message.value = result.message
    return false
  }
  reload()
  return true
}

function dispatch(row: EntryRow) {
  announce(dispatchLeak(Number(row.id), actor()))
}

function complete(row: EntryRow) {
  announce(completeLeak(Number(row.id), actor()))
}

function redispatch(row: EntryRow) {
  announce(redispatchRework(Number(row.id), actor()))
}

// --- 登记 ---
const createOpen = ref(false)
const createForm = reactive({ cabin: '', point: '', team: '', foundDate: '', mode: DEGREE_PENDING, degree: '', reason: '' })

function openCreate() {
  modalError.value = ''
  Object.assign(createForm, { cabin: '', point: '', team: '', foundDate: '', mode: DEGREE_PENDING, degree: '', reason: '' })
  createOpen.value = true
}

function submitCreate() {
  modalError.value = ''
  const result = createLeak(
    {
      所属舱室: createForm.cabin,
      渗漏点位: createForm.point,
      处置班组: createForm.team,
      发现日期: createForm.foundDate,
      渗漏程度: createForm.mode === 'measured' ? createForm.degree : '',
      程度状态: createForm.mode === 'measured' ? DEGREE_MEASURED : createForm.mode,
      未测原因: createForm.reason,
    } as Partial<EntryRow>,
    actor(),
  )
  if (!result.ok) {
    modalError.value = result.message
    return
  }
  createOpen.value = false
  reload()
}

// --- 重试测取 ---
const measureOpen = ref(false)
const measureTarget = ref<EntryRow | null>(null)
const measureForm = reactive({ mode: 'measured', degree: '', reason: '' })

function openMeasure(row: EntryRow) {
  modalError.value = ''
  measureTarget.value = row
  const wasMeasured = String(row['程度状态']) === DEGREE_MEASURED
  Object.assign(measureForm, { mode: wasMeasured ? 'measured' : 'measured', degree: wasMeasured ? String(row['渗漏程度']) : '', reason: '' })
  measureOpen.value = true
}

function submitMeasure() {
  if (!measureTarget.value) {
    return
  }
  const payload = measureForm.mode === 'measured'
    ? { measured: true as const, degree: measureForm.degree }
    : { measured: false as const, state: measureForm.mode, reason: measureForm.reason }
  const result = retryMeasure(Number(measureTarget.value.id), payload, actor())
  if (!result.ok) {
    modalError.value = result.message
    return
  }
  measureOpen.value = false
  reload()
}

// --- 返工 ---
const reworkOpen = ref(false)
const reworkTarget = ref<EntryRow | null>(null)
const reworkReason = ref('')

function openRework(row: EntryRow) {
  modalError.value = ''
  reworkTarget.value = row
  reworkReason.value = ''
  reworkOpen.value = true
}

function submitRework() {
  if (!reworkTarget.value) {
    return
  }
  const result = requestRework(Number(reworkTarget.value.id), reworkReason.value, actor())
  if (!result.ok) {
    modalError.value = result.message
    return
  }
  reworkOpen.value = false
  reload()
}

// --- 整批补录 ---
const backfillOpen = ref(false)
const backfillText = ref('')

function openBackfill() {
  modalError.value = ''
  backfillText.value = ''
  backfillOpen.value = true
}

function submitBackfill() {
  modalError.value = ''
  const records = backfillText.value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [cabin, point, date, degree = '', team = '', method = ''] = line.split(',').map((cell) => cell.trim())
      return { 所属舱室: cabin, 渗漏点位: point, 发现日期: date, 渗漏程度: degree, 处置班组: team, 处置方式: method }
    })
  if (records.some((item) => !item.所属舱室 || !item.渗漏点位 || !item.发现日期)) {
    modalError.value = '每行至少要有所属舱室、渗漏点位、发现日期三列'
    return
  }
  const batch = todayBatch()
  const result = backfillLegacy(records, actor(), batch)
  if (!result.ok) {
    modalError.value = result.message
    return
  }
  backfillOpen.value = false
  reload()
}

function todayBatch(): string {
  return new Date().toISOString().slice(0, 10).replace(/-/g, '')
}

onMounted(reload)
</script>
