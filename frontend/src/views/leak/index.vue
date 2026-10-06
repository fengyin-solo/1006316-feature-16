<template>
  <section class="page" data-module="leak">
    <header class="page-head">
      <div>
        <h2>渗漏水处置管理</h2>
        <p class="page-desc">
          渗漏程度取不到留空显示「待测」并写明原因，空值禁止进入处置中；返工必填原因并回写检修待办与安防台账。
          完整口径见 <code>docs/渗漏水处置边界规则.md</code>。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记渗漏处置单</button>
        <button class="btn" type="button" @click="runBackfill">历史补录批次处理</button>
        <button class="btn ghost" type="button" @click="toggleReconcile">{{ showReconcile ? '收起对账' : '联动对账' }}</button>
        <button class="btn ghost" type="button" @click="exportRows">导出清单</button>
      </div>
    </header>

    <div class="session-bar">
      <span>当前身份：</span>
      <label>
        单位
        <select :value="session.unit" @change="session.setUnit(($event.target as HTMLSelectElement).value)">
          <option v-for="unit in UNIT_OPTIONS" :key="unit" :value="unit">{{ unit }}</option>
        </select>
      </label>
      <label>
        岗位
        <select :value="session.post" @change="session.setPost(($event.target as HTMLSelectElement).value)">
          <option v-for="post in POST_OPTIONS" :key="post" :value="post">{{ post }}</option>
        </select>
      </label>
      <span class="session-hint">切到「第二运维所/外部协同单位」可验证跨单位只读：动作按钮隐藏、越权提交服务层拒绝。</span>
    </div>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <div v-if="showReconcile" class="reconcile-panel" :class="{ inconsistent: !report.consistent }">
      <h3>联动对账（实时）</h3>
      <p>
        设施检修待办「待复核（渗漏联动）」：<strong>{{ report.reviewKeys.length }}</strong> 条
        ｜ 安防台账「需整改（渗漏联动）」：<strong>{{ report.accessKeys.length }}</strong> 条
        ｜ 值班清单渗漏联动事项：<strong>{{ report.dutyEvents }}</strong> 条
      </p>
      <p v-if="report.consistent" class="consistent">条数一致，1:1 对齐。</p>
      <div v-else>
        <p class="error-text">条数不一致：</p>
        <ul>
          <li v-for="key in report.missingInAccess" :key="'m' + key">安防台账缺少 {{ key }} 的整改记录</li>
          <li v-for="key in report.staleInAccess" :key="'s' + key">安防台账 {{ key }} 的整改记录应随闭环撤销</li>
        </ul>
      </div>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field.key" class="filter-item">
        <span>{{ field.label }}</span>
        <input v-model="filters[field.key]" :placeholder="field.placeholder" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table leak-table">
      <thead>
        <tr>
          <th>处置编号</th>
          <th>渗漏点位 / 编码</th>
          <th>渗漏程度</th>
          <th>实测流量(L/min)</th>
          <th>处置方式 / 班组</th>
          <th>来源</th>
          <th>归属</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)" :class="{ readonly: !isWritable(row) }">
          <td>
            {{ row.处置编号 }}
            <div class="sub-text">发现 {{ row.发现日期 }}{{ row.完工日期 ? ` ／ 完工 ${row.完工日期}` : '' }}</div>
          </td>
          <td>
            {{ row.渗漏点位 }}
            <div class="sub-text">{{ row.点位编码 || '点位编码待补（缺舱室或桩号）' }}</div>
          </td>
          <td>
            <span v-if="row.程度状态 === '已实测'">{{ row.渗漏程度 }}</span>
            <span v-else-if="row.程度状态 === '中断'" class="badge interrupted">中断</span>
            <span v-else class="badge pending-measure">待测</span>
            <div v-if="row.程度状态 === '待测（空态）'" class="sub-text warn">空态原因：{{ row.未测原因 }}</div>
            <div v-else-if="row.程度状态 === '中断'" class="sub-text warn">中断原因：{{ row.中断原因 }}</div>
            <div v-if="row.返工原因" class="sub-text rework">返工：{{ row.返工原因 }}</div>
            <div class="sub-text">采集第 {{ row.采集轮次 ?? 0 }} 轮</div>
          </td>
          <td>
            <span v-if="row.程度状态 === '已实测'">{{ row.实测流量 }}</span>
            <span v-else class="empty-cell">不得记 0</span>
          </td>
          <td>
            <span>{{ row.处置方式 || '—' }}</span>
            <div class="sub-text">{{ row.处置班组 || '班组未安排' }}</div>
          </td>
          <td>
            <span class="source-tag" :class="{ legacy: String(row.来源标记).includes('历史补录') }">{{ row.来源标记 }}</span>
          </td>
          <td>
            {{ row.归属单位 }}
            <div class="sub-text">{{ row.归口岗位 }}</div>
          </td>
          <td><span class="status-tag" :data-status="row.status">{{ row.status }}</span></td>
          <td class="row-actions">
            <template v-if="isWritable(row)">
              <template v-if="row.status === '待处置'">
                <button class="link" type="button" @click="doDispatch(row)">派出处置</button>
                <button class="link" type="button" @click="openRetake(row)">重新采集</button>
              </template>
              <template v-else-if="row.status === '处置中'">
                <button class="link" type="button" @click="doComplete(row)">确认完工</button>
                <button class="link" type="button" @click="openRework(row)">要求返工</button>
              </template>
              <template v-else-if="row.status === '需返工'">
                <button class="link" type="button" @click="openRetake(row)">重新采集</button>
                <button class="link" type="button" @click="doFinishRework(row)">返工完成</button>
              </template>
              <template v-else-if="row.status === '待复核'">
                <button class="link" type="button" @click="doReviewPass(row)">复核通过</button>
                <button class="link" type="button" @click="openReject(row)">复核不通过</button>
              </template>
              <span v-else class="sub-text">已闭环</span>
            </template>
            <span v-else class="readonly-tag">跨单位只读</span>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td colspan="9" class="empty-state">暂无渗漏水处置数据，可先登记渗漏处置单</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ rows.length }} 条渗漏水处置记录</span>
      <span v-if="message" class="flash" :class="messageOk ? 'ok' : 'error-text'">{{ message }}</span>
    </footer>

    <!-- 登记处置单 -->
    <div v-if="createOpen" class="modal-mask" @click.self="createOpen = false">
      <div class="modal">
        <h3>登记渗漏处置单</h3>
        <label class="form-row">
          <span>渗漏点位（含舱室+里程桩号+部位）</span>
          <input v-model="createForm.渗漏点位" placeholder="例：综合舱 K1+220 左墙施工缝" />
        </label>
        <label class="form-row">
          <span>发现日期（老记录填业务发生日，不填今天）</span>
          <input v-model="createForm.发现日期" type="date" />
        </label>
        <fieldset class="form-row">
          <legend>渗漏程度测量</legend>
          <label><input v-model="createForm.kind" type="radio" value="measured" /> 已实测</label>
          <label><input v-model="createForm.kind" type="radio" value="empty" /> 取不到（空态待测）</label>
          <label><input v-model="createForm.kind" type="radio" value="interrupted" /> 测量中断</label>
        </fieldset>
        <label v-if="createForm.kind === 'measured'" class="form-row">
          <span>实测流量 L/min（干裂缝填 0，且必须是实测值）</span>
          <input v-model.number="createForm.flow" type="number" min="0" step="0.01" />
        </label>
        <label v-if="createForm.kind === 'empty'" class="form-row">
          <span>未测原因（必填）</span>
          <textarea v-model="createForm.reason" rows="2" placeholder="例：计量设备未到场 / 积水遮挡测点" />
        </label>
        <label v-if="createForm.kind === 'interrupted'" class="form-row">
          <span>中断原因（必填）</span>
          <textarea v-model="createForm.reason" rows="2" placeholder="例：抽水设备故障，测量中断" />
        </label>
        <label class="form-row">
          <span>处置班组（可派工前再补）</span>
          <input v-model="createForm.处置班组" placeholder="例：堵漏一班" />
        </label>
        <p v-if="message" class="error-text">{{ message }}</p>
        <div class="modal-actions">
          <button class="btn ghost" type="button" @click="createOpen = false">取消</button>
          <button class="btn primary" type="button" @click="submitCreate">提交登记</button>
        </div>
      </div>
    </div>

    <!-- 重新采集（重试入口） -->
    <div v-if="retakeOpen" class="modal-mask" @click.self="retakeOpen = false">
      <div class="modal">
        <h3>重新采集：{{ retakeTarget?.处置编号 }}</h3>
        <p class="sub-text">重试入口默认带出上一次没取到的数据重采；已实测字段锁定，不会被清空。</p>
        <ul class="missing-list">
          <li v-for="item in retakeMissing" :key="item" class="warn">待补：{{ item }}</li>
          <li v-if="!retakeMissing.length" class="ok">缺项已补齐，可直接派工/提交复核。</li>
        </ul>
        <fieldset class="form-row">
          <legend>本轮采集结果</legend>
          <label><input v-model="retakeForm.state" type="radio" value="已实测" /> 已实测</label>
          <label><input v-model="retakeForm.state" type="radio" value="待测（空态）" /> 仍取不到（空态）</label>
          <label><input v-model="retakeForm.state" type="radio" value="中断" /> 测量中断</label>
        </fieldset>
        <label v-if="retakeForm.state === '已实测'" class="form-row">
          <span>实测流量 L/min</span>
          <input v-model.number="retakeForm.flow" type="number" min="0" step="0.01" />
          <span class="sub-text">保存后按实测值重判等级、重算处置方式建议（现场实测为权威值）。</span>
        </label>
        <label v-else class="form-row">
          <span>{{ retakeForm.state === '中断' ? '中断原因' : '未测原因' }}（必填）</span>
          <textarea v-model="retakeForm.reason" rows="2" />
        </label>
        <label class="form-row">
          <span>处置班组（如需补/改）</span>
          <input v-model="retakeForm.处置班组" :placeholder="String(retakeTarget?.处置班组 ?? '')" />
        </label>
        <p v-if="message" class="error-text">{{ message }}</p>
        <div class="modal-actions">
          <button class="btn ghost" type="button" @click="retakeOpen = false">取消</button>
          <button class="btn primary" type="button" @click="submitRetake">提交本轮采集</button>
        </div>
      </div>
    </div>

    <!-- 要求返工 / 复核不通过：原因必填 -->
    <div v-if="reasonOpen" class="modal-mask" @click.self="reasonOpen = false">
      <div class="modal">
        <h3>{{ reasonMode === 'rework' ? '要求返工' : '复核不通过' }}：{{ reasonTarget?.处置编号 }}</h3>
        <label class="form-row">
          <span>{{ reasonMode === 'rework' ? '返工原因' : '不通过原因' }}（必填，不填拒绝提交）</span>
          <textarea v-model="reasonText" rows="3" placeholder="例：封堵后仍有明水，注浆不饱满" />
        </label>
        <p v-if="message" class="error-text">{{ message }}</p>
        <div class="modal-actions">
          <button class="btn ghost" type="button" @click="reasonOpen = false">取消</button>
          <button class="btn primary" type="button" @click="submitReason">提交</button>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'

import { downloadEntries, moduleMeta } from '@/api/local-service'
import {
  backfillLegacy,
  completeOrder,
  createLeakOrder,
  dispatchOrder,
  finishRework,
  leakStats,
  listLeakOrders,
  missingBeforeDispatch,
  reconcile,
  requestRework,
  retakeMeasurement,
  reviewPassAndClose,
  reviewReject,
  type RetakeInput,
} from '@/api/leak-service'
import type { EntryRow } from '@/data/types'
import { POST_OPTIONS, UNIT_OPTIONS, useSessionStore } from '@/stores/session'

const meta = moduleMeta('leak')
const session = useSessionStore()

const statuses = ['待处置', '处置中', '需返工', '待复核', '已完工']
const rows = ref<EntryRow[]>([])
const message = ref('')
const messageOk = ref(false)
const filters = reactive<Record<string, string>>({ 处置编号: '', 渗漏点位: '', 程度状态: '' })
const filterFields = [
  { key: '处置编号', label: '处置编号', placeholder: '按处置编号检索' },
  { key: '渗漏点位', label: '渗漏点位', placeholder: '按点位/编码检索' },
  { key: '程度状态', label: '程度状态', placeholder: '已实测/待测/中断' },
]

const showReconcile = ref(false)
const report = ref(reconcile())
const stats = computed(() => leakStats(rows.value))
const statusSummary = computed(() =>
  statuses.map((status) => ({ status, count: rows.value.filter((row) => String(row.status) === status).length })),
)

function flash(text: string, ok = false) {
  message.value = text
  messageOk.value = ok
}

function isWritable(row: EntryRow): boolean {
  return !row.归属单位 || row.归属单位 === session.unit
}

function resetFilters() {
  for (const key of Object.keys(filters)) filters[key] = ''
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function reload() {
  rows.value = listLeakOrders(filters)
  report.value = reconcile()
}

// ---- 登记 ----
const createOpen = ref(false)
const createForm = reactive({
  渗漏点位: '',
  发现日期: '',
  kind: 'empty' as 'measured' | 'empty' | 'interrupted',
  flow: '' as number | string,
  reason: '',
  处置班组: '',
})

function openCreate() {
  createOpen.value = true
  message.value = ''
  createForm.渗漏点位 = ''
  createForm.发现日期 = new Date().toISOString().slice(0, 10)
  createForm.kind = 'empty'
  createForm.flow = ''
  createForm.reason = ''
  createForm.处置班组 = ''
}

function submitCreate() {
  const result = createLeakOrder(
    {
      渗漏点位: createForm.渗漏点位,
      发现日期: createForm.发现日期,
      实测流量: createForm.kind === 'measured' ? Number(createForm.flow) : null,
      未测原因: createForm.kind === 'empty' ? createForm.reason : undefined,
      中断原因: createForm.kind === 'interrupted' ? createForm.reason : undefined,
      处置班组: createForm.处置班组,
    },
    session.actor,
  )
  flash(result.message, result.ok)
  if (result.ok) {
    createOpen.value = false
    reload()
  }
}

// ---- 直接动作 ----
function doDispatch(row: EntryRow) {
  const result = dispatchOrder(Number(row.id), session.actor)
  flash(result.message, result.ok)
  reload()
}

function doComplete(row: EntryRow) {
  const result = completeOrder(Number(row.id), session.actor)
  flash(result.message, result.ok)
  reload()
}

function doFinishRework(row: EntryRow) {
  const result = finishRework(Number(row.id), session.actor)
  flash(result.message, result.ok)
  reload()
}

function doReviewPass(row: EntryRow) {
  const result = reviewPassAndClose(Number(row.id), session.actor)
  flash(result.message, result.ok)
  reload()
}

// ---- 原因类动作 ----
const reasonOpen = ref(false)
const reasonMode = ref<'rework' | 'reject'>('rework')
const reasonTarget = ref<EntryRow | null>(null)
const reasonText = ref('')

function openRework(row: EntryRow) {
  reasonMode.value = 'rework'
  reasonTarget.value = row
  reasonText.value = ''
  reasonOpen.value = true
  message.value = ''
}

function openReject(row: EntryRow) {
  reasonMode.value = 'reject'
  reasonTarget.value = row
  reasonText.value = ''
  reasonOpen.value = true
  message.value = ''
}

function submitReason() {
  if (!reasonTarget.value) return
  const id = Number(reasonTarget.value.id)
  const result =
    reasonMode.value === 'rework'
      ? requestRework(id, reasonText.value, session.actor)
      : reviewReject(id, reasonText.value, session.actor)
  flash(result.message, result.ok)
  if (result.ok) {
    reasonOpen.value = false
    reload()
  }
}

// ---- 重新采集 ----
const retakeOpen = ref(false)
const retakeTarget = ref<EntryRow | null>(null)
const retakeForm = reactive<{ state: RetakeInput['state']; flow: number | string; reason: string; 处置班组: string }>({
  state: '已实测',
  flow: '',
  reason: '',
  处置班组: '',
})
const retakeMissing = ref<string[]>([])

function openRetake(row: EntryRow) {
  retakeTarget.value = row
  retakeMissing.value = missingBeforeDispatch(row)
  const interrupted = row.程度状态 === '中断'
  retakeForm.state = interrupted ? '中断' : '已实测'
  retakeForm.flow = typeof row.实测流量 === 'number' ? row.实测流量 : ''
  retakeForm.reason = String(row.中断原因 || row.未测原因 || '')
  retakeForm.处置班组 = ''
  retakeOpen.value = true
  message.value = ''
}

function submitRetake() {
  if (!retakeTarget.value) return
  const result = retakeMeasurement(
    Number(retakeTarget.value.id),
    {
      state: retakeForm.state,
      flow: retakeForm.state === '已实测' ? Number(retakeForm.flow) : null,
      reason: retakeForm.reason,
      处置班组: retakeForm.处置班组,
    },
    session.actor,
  )
  flash(result.message, result.ok)
  if (result.ok) {
    retakeOpen.value = false
    reload()
  }
}

// ---- 历史补录 ----
function runBackfill() {
  const result = backfillLegacy(session.actor)
  flash(
    `批次 ${result.batch} 处理 ${result.processed} 条：${result.messages.join('｜') || '无待补录记录'}`,
    true,
  )
  reload()
}

function toggleReconcile() {
  showReconcile.value = !showReconcile.value
  report.value = reconcile()
}

onMounted(reload)
</script>
