import { defineStore } from 'pinia'

// 演示用单位字典：真实系统里单位、岗位、人员来自登录态，这里用固定名单模拟切换。
export const UNIT_OPTIONS = ['第一运维所', '第二运维所', '外部协同单位'] as const
export const POST_OPTIONS = ['渗漏处置岗', '设施检修岗', '安防管理岗', '值班岗'] as const

export type Actor = {
  operator: string
  unit: string
  post: string
}

export const useSessionStore = defineStore('session', {
  state: () => ({
    operator: '值班管理员',
    shiftLabel: '白班 08:00-20:00',
    scope: '城市地下综合管廊运行维护管理平台',
    // 默认第一运维所·渗漏处置岗，可在渗漏页面切换单位用于演示跨单位只读。
    unit: UNIT_OPTIONS[0] as string,
    post: POST_OPTIONS[0] as string,
  }),
  getters: {
    canOperate: (state) => state.operator.length > 0,
    actor: (state): Actor => ({ operator: state.operator, unit: state.unit, post: state.post }),
  },
  actions: {
    setShift(label: string) {
      this.shiftLabel = label
    },
    setUnit(unit: string) {
      this.unit = unit
    },
    setPost(post: string) {
      this.post = post
    },
  },
})
