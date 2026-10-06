<template>
  <section class="page" data-module="maintenance">
    <header class="page-head">
      <div>
        <h2>设施检修管理</h2>
        <p class="page-desc">
          渗漏处置的返工结论与安防台账「需整改」以「待复核」待办回写到这里：一个来源一条待办，
          条数与来源台账保持一致，复核闭环后自动核销。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="exportRows">导出设施检修清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in statCards" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label class="filter-item">
        <span>检修对象/编号</span>
        <input v-model="keyword" placeholder="按检修对象或编号检索" />
      </label>
      <label class="filter-item">
        <span>待办来源</span>
        <select v-model="sourceFilter">
          <option value="">全部</option>
          <option value="渗漏返工">渗漏返工回写</option>
          <option value="安防整改">安防整改回写</option>
          <option value="自建">常规检修</option>
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
        <tr v-for="row in rows" :key="String(row.id)" :class="{ linked: !!row['关联来源'] }">
          <td v-for="column in columns" :key="column">{{ row[column] || '—' }}</td>
          <td>
            {{ row.status }}
            <span v-if="row['关联来源']" class="link-tag">{{ row['关联来源'] }}回写</span>
          </td>
          <td class="row-actions">
            <template v-if="row.status === '待复核'">
              <button class="link primary-link" type="button" @click="runAction('复核闭环', row)">复核闭环</button>
            </template>
            <template v-else-if="!row['关联来源']">
              <button
                v-for="action in regularActions"
                :key="action"
                class="link"
                type="button"
                @click="runAction(action, row)"
              >
                {{ action }}
              </button>
            </template>
            <span v-else class="muted">等待复核</span>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无设施检修记录</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条检修记录，其中回写待办 {{ linkedCount }} 条</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  reconcileAll,
  runAction as applyAction,
} from '@/api/local-service'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('maintenance')
const columns = ['检修编号', '检修对象', '检修类别', '检修班组', '关联来源', '关联单号', '待复核内容', '归属单位', '归属岗位']
const regularActions = ['提交开工', '确认完工', '申请延期']
const statuses = ['待开工', '检修中', '待复核', '已完工', '已延期']

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const keyword = ref('')
const sourceFilter = ref('')

const allRows = ref<EntryRow[]>([])
const linkedCount = computed(() => rows.value.filter((row) => !!row['关联来源']).length)

const statCards = computed(() => {
  const count = (status: string) => rows.value.filter((row) => String(row.status) === status).length
  return [
    { label: '待开工检修', value: count('待开工') },
    { label: '检修中记录', value: count('检修中') },
    { label: '待复核待办（回写）', value: count('待复核') },
    { label: '已完工', value: count('已完工') },
  ]
})

const statusSummary = computed(() =>
  statuses.map((status) => ({ status, count: rows.value.filter((row) => String(row.status) === status).length })),
)

function resetFilters() {
  keyword.value = ''
  sourceFilter.value = ''
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    reconcileAll()
    allRows.value = listEntries(meta.key).items
    const word = keyword.value.trim()
    rows.value = allRows.value.filter((row) => {
      if (word) {
        const haystack = `${String(row['检修编号'] ?? '')}${String(row['检修对象'] ?? '')}`
        if (!haystack.includes(word)) {
          return false
        }
      }
      if (sourceFilter.value) {
        const source = String(row['关联来源'] ?? '')
        if (sourceFilter.value === '自建') {
          if (source) {
            return false
          }
        } else if (source !== sourceFilter.value) {
          return false
        }
      }
      return true
    })
    total.value = rows.value.length
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '设施检修列表读取失败'
  }
}

onMounted(reload)
</script>
