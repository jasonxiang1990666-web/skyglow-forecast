const { getNext24HourForecast } = require('../../services/weather')

function countdownText(minutes) {
  const safeMinutes = Math.max(0, minutes)
  const hours = Math.floor(safeMinutes / 60)
  const rest = safeMinutes % 60
  if (hours > 0) return `${hours}小时${rest}分`
  return `${rest}分钟`
}

function adviceFor(skyWindow, selected, warning) {
  if (warning) return '当前存在气象预警，请优先注意安全，不建议外出观赏。'
  if (skyWindow.rainImpact) return `${skyWindow.rainImpact}，建议以天气安排为主。`
  if (selected.tier === 'high') return `很值得等一等。建议在${skyWindow.startTime || skyWindow.time}前后提前留意天空变化。`
  if (selected.tier === 'medium') return '可以顺路留意天空变化，但不建议专程等待。'
  return '本次霞况不太明显，不建议专程出门观霞。'
}

Page({
  data: {
    city: '',
    skyWindow: null,
    selected: null,
    warning: null,
    advice: '',
    countdown: null,
    loading: true,
    loadError: '',
    updatedAt: ''
  },

  onLoad(options) {
    this.windowIndex = Number(options.window) || 0
    this.skyType = decodeURIComponent(options.type || '')
  },

  onShow() {
    this.loadDetail()
  },

  onHide() {
    this.stopCountdown()
  },

  onUnload() {
    this.stopCountdown()
  },

  onPullDownRefresh() {
    this.loadDetail(true)
  },

  loadDetail(fromPullDown = false) {
    const city = wx.getStorageSync('selectedCity') || getApp().globalData.defaultCity
    this.setData({ city, loading: !fromPullDown, loadError: '' })
    getNext24HourForecast(city)
      .then((forecast) => {
        const windows = forecast.skyWindows || [forecast.primaryWindow, forecast.secondaryWindow].filter(Boolean)
        const skyWindow = windows[this.windowIndex] || windows[0]
        if (!skyWindow) throw new Error('未获得霞况窗口')

        const selected = skyWindow.skies.find((item) => item.type === this.skyType) || skyWindow.hero
        const normalizedWindow = {
          ...skyWindow,
          factors: skyWindow.factors || { favorable: [], unfavorable: [] },
          hourlyTimeline: skyWindow.hourlyTimeline || []
        }
        this.setData({
          skyWindow: normalizedWindow,
          selected,
          warning: forecast.warning || null,
          advice: adviceFor(normalizedWindow, selected, forecast.warning),
          updatedAt: forecast.updatedAt,
          loading: false
        })
        wx.setNavigationBarTitle({ title: `${selected.type}详情` })
        this.startCountdown()
      })
      .catch(() => {
        this.setData({ loading: false, loadError: '暂时无法加载霞况详情，请稍后重试。' })
        wx.showToast({ title: '天气数据加载失败', icon: 'none' })
      })
      .finally(() => {
        if (fromPullDown) wx.stopPullDownRefresh()
      })
  },

  retry() {
    this.loadDetail()
  },

  startCountdown() {
    this.stopCountdown()
    this.updateCountdown()
    this.countdownTimer = setInterval(() => this.updateCountdown(), 60 * 1000)
  },

  stopCountdown() {
    if (this.countdownTimer) {
      clearInterval(this.countdownTimer)
      this.countdownTimer = null
    }
  },

  updateCountdown() {
    const skyWindow = this.data.skyWindow
    if (!skyWindow) return

    if (!Number.isFinite(Number(skyWindow.startAt)) || !Number.isFinite(Number(skyWindow.endAt))) {
      this.setData({
        countdown: {
          state: 'upcoming',
          title: '建议观赏时段',
          value: skyWindow.time || '时间同步中',
          detail: '正在同步最新预报时间'
        }
      })
      return
    }

    const now = Date.now()
    let countdown
    if (now < skyWindow.startAt) {
      const minutes = Math.ceil((skyWindow.startAt - now) / (60 * 1000))
      countdown = {
        state: 'upcoming',
        title: '距建议观赏开始还有',
        value: countdownText(minutes),
        detail: `建议 ${skyWindow.startTime}–${skyWindow.endTime} 留意天空`
      }
    } else if (now <= skyWindow.endAt) {
      const minutes = Math.ceil((skyWindow.endAt - now) / (60 * 1000))
      countdown = {
        state: 'active',
        title: '现在正是建议观赏时段',
        value: `还剩 ${countdownText(minutes)}`,
        detail: '云层变化较快，请以现场天空状况为准'
      }
    } else {
      this.stopCountdown()
      this.loadDetail()
      return
    }
    this.setData({ countdown })
  }
})
