const { getNext24HourForecast, getNearbyViewingSpots, getFeaturedViewingSpots } = require('../../services/weather')

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
    airReference: null,
    fireCloud: null,
    nearbySpots: null,
    nearbyLoading: false,
    nearbyMessage: '',
    featuredSpots: null,
    featuredPreviewSpots: [],
    featuredLoading: false,
    advice: '',
    countdown: null,
    loading: true,
    loadError: '',
    updatedAt: ''
  },

  onLoad(options) {
    this.windowIndex = Number(options.window) || 0
  },

  onShareAppMessage() {
    const city = this.data.city || wx.getStorageSync('selectedCity') || '当前城市'
    const selected = this.data.selected || {}
    return {
      title: `${city}${selected.type || '霞况'}预报`,
      path: `/pages/sky-detail/sky-detail?window=${this.windowIndex || 0}&from=share`
    }
  },

  onShow() {
    const shareTask = wx.showShareMenu({ menus: ['shareAppMessage'], withShareTicket: true })
    if (shareTask && typeof shareTask.catch === 'function') shareTask.catch(() => {})
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

        const skies = Array.isArray(skyWindow.skies) ? skyWindow.skies : []
        const selected = skyWindow.primarySky || skies.find((item) => item.type === '朝霞' || item.type === '晚霞') || skyWindow.hero || skies[0]
        const fireCloud = skyWindow.fireCloud || skies.find((item) => item.type === '火烧云') || null
        if (!selected) throw new Error('未获得霞况数据')
        const normalizedWindow = {
          ...skyWindow,
          primarySky: selected,
          fireCloud,
          factors: skyWindow.factors || { favorable: [], unfavorable: [] },
          hourlyTimeline: skyWindow.hourlyTimeline || []
        }
        this.setData({
          city: forecast.locationLabel || wx.getStorageSync('selectedLocationLabel') || forecast.city || city,
          skyWindow: normalizedWindow,
          selected,
          fireCloud,
          warning: forecast.warning || null,
          airReference: forecast.airReference || null,
          advice: adviceFor(normalizedWindow, selected, forecast.warning),
          updatedAt: forecast.updatedAt,
          loading: false
        })
        wx.setNavigationBarTitle({ title: `${selected.type}与火烧云详情` })
        this.startCountdown()
        this.loadFeaturedSpots(city, normalizedWindow)
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

  loadFeaturedSpots(city, skyWindow) {
    this.setData({ featuredLoading: true, featuredSpots: null, featuredPreviewSpots: [] })
    getFeaturedViewingSpots(city, { scene: skyWindow.kind })
      .then((featuredSpots) => this.setData({
        featuredSpots,
        featuredPreviewSpots: (featuredSpots.spots || []).slice(0, 2),
        featuredLoading: false
      }))
      .catch((error) => {
        console.warn('Featured viewing spots unavailable', error)
        this.setData({
          featuredLoading: false,
          featuredSpots: { enabled: false, spots: [], message: '精选观赏点暂时无法获取。' },
          featuredPreviewSpots: []
        })
      })
  },

  goFeaturedSpots() {
    const skyWindow = this.data.skyWindow
    if (!skyWindow) return
    const city = wx.getStorageSync('selectedCity') || this.data.city
    const query = `city=${encodeURIComponent(city)}&scene=${encodeURIComponent(skyWindow.kind || '')}&windowStart=${Number(skyWindow.startAt) || 0}`
    wx.navigateTo({ url: `/pages/viewing-spots/viewing-spots?${query}` })
  },

  goFeaturedSpot(event) {
    const id = event.currentTarget.dataset.id
    const skyWindow = this.data.skyWindow
    if (!id || !skyWindow) return
    const city = wx.getStorageSync('selectedCity') || this.data.city
    const query = `id=${encodeURIComponent(id)}&city=${encodeURIComponent(city)}&scene=${encodeURIComponent(skyWindow.kind || '')}&windowStart=${Number(skyWindow.startAt) || 0}`
    wx.navigateTo({ url: `/pages/spot-detail/spot-detail?${query}` })
  },

  loadNearbySpots() {
    const skyWindow = this.data.skyWindow
    if (!skyWindow || this.data.nearbyLoading) return

    this.setData({ nearbyLoading: true, nearbyMessage: '' })
    wx.getLocation({
      type: 'gcj02',
      success: (location) => {
        getNearbyViewingSpots({
          latitude: location.latitude,
          longitude: location.longitude,
          scene: skyWindow.kind
        }).then((nearbySpots) => {
          this.setData({
            nearbySpots,
            nearbyLoading: false,
            nearbyMessage: nearbySpots.enabled ? '' : nearbySpots.message
          })
        }).catch((error) => {
          console.warn('Nearby viewing spots unavailable', error)
          this.setData({
            nearbyLoading: false,
            nearbyMessage: '暂时无法获取附近地点，请稍后重试。'
          })
        })
      },
      fail: () => {
        this.setData({
          nearbyLoading: false,
          nearbyMessage: '允许定位后，才能按距离推荐附近开阔地点。'
        })
      }
    })
  },

  openSpotLocation(event) {
    const item = event.currentTarget.dataset.item
    if (!item || !Number.isFinite(Number(item.latitude)) || !Number.isFinite(Number(item.longitude))) return
    wx.openLocation({
      latitude: Number(item.latitude),
      longitude: Number(item.longitude),
      name: item.name,
      address: item.address || '',
      scale: 17
    })
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
