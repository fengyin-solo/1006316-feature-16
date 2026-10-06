import { defineStore } from 'pinia'

// 演示用的单位清单：跨单位单据只读，越权提交在服务层拒绝。
export const UNITS = ['第一管廊管理所', '第二管廊管理所'] as const

export const useSessionStore = defineStore('session', {
  state: () => ({
    operator: '张工',
    post: '渗漏处置岗',
    unit: '第一管廊管理所',
    shiftLabel: '白班 08:00-20:00',
    scope: '城市地下综合管廊运行维护管理平台',
  }),
  getters: {
    canOperate: (state) => state.operator.length > 0,
  },
  actions: {
    setShift(label: string) {
      this.shiftLabel = label
    },
    setUnit(unit: string) {
      this.unit = unit
    },
  },
})
