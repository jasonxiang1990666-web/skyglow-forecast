const { getNext24HourForecast, getNationalCityOverview } = require('../../services/weather')
const { withWarningRainFallback } = require('../../utils/rain')

function durationText(minutes) {
  const safeMinutes = Math.max(0, minutes)
  const hours = Math.floor(safeMinutes / 60)
  const rest = safeMinutes % 60
  return hours > 0 ? `${hours}小时${rest}分` : `${rest}分钟`
}

function solarCountdown(window) {
  const solarAt = Number(window && window.solarAt)
  if (!Number.isFinite(solarAt)) return ''
  const label = window.kind === 'sunrise' ? '日出' : '日落'
  const difference = solarAt - Date.now()
  if (difference >= 0) return `距${label} ${durationText(Math.ceil(difference / (60 * 1000)))}`
  return `${label}后 ${durationText(Math.ceil(Math.abs(difference) / (60 * 1000)))}`
}

Page({
  data: {
    city: '杭州',
    forecast: null,
    loading: true,
    nationalOverview: null,
    nationalOverviewLoading: false,
    solarCountdown: '',
    statusBarHeight: 20,
    navContentHeight: 44,
    menuRightSpace: 108
  },

  onLoad() {
    this.setNavigationMetrics()
  },

  onShow() {
    const city = wx.getStorageSync('selectedCity') || getApp().globalData.defaultCity
    this.setData({ city })
    this.loadForecast(city)
  },

  onHide() {
    this.stopSolarCountdown()
  },

  onUnload() {
    this.stopSolarCountdown()
  },

  loadForecast(city) {
    const requestId = (this.overviewRequestId || 0) + 1
    this.overviewRequestId = requestId
    this.setData({ loading: true, nationalOverview: null, nationalOverviewLoading: false })
    getNext24HourForecast(city)
      .then((forecast) => {
        const normalizedForecast = withWarningRainFallback(forecast)
        this.setData({ forecast: normalizedForecast, loading: false })
        this.startSolarCountdown()
        this.loadNationalOverview(city, normalizedForecast.primaryWindow, requestId)
      })
      .catch(() => {
        this.stopSolarCountdown()
        this.setData({ loading: false })
        wx.showToast({ title: '天气数据加载失败', icon: 'none' })
      })
  },

  startSolarCountdown() {
    this.stopSolarCountdown()
    this.updateSolarCountdown()
    this.solarTimer = setInterval(() => this.updateSolarCountdown(), 60 * 1000)
  },

  stopSolarCountdown() {
    if (this.solarTimer) {
      clearInterval(this.solarTimer)
      this.solarTimer = null
    }
  },

  updateSolarCountdown() {
    const forecast = this.data.forecast
    if (!forecast || !forecast.primaryWindow) return
    this.setData({ solarCountdown: solarCountdown(forecast.primaryWindow) })
  },

  loadNationalOverview(city, skyWindow, requestId) {
    const targetAt = Number(skyWindow && (skyWindow.solarAt || skyWindow.startAt))
    if (!Number.isFinite(targetAt)) return

    this.setData({ nationalOverviewLoading: true })
    getNationalCityOverview(city, { scene: skyWindow.kind, targetAt })
      .then((nationalOverview) => {
        if (requestId !== this.overviewRequestId) return
        this.setData({ nationalOverview, nationalOverviewLoading: false })
      })
      .catch((error) => {
        console.warn('National city overview unavailable', error)
        if (requestId === this.overviewRequestId) this.setData({ nationalOverviewLoading: false })
      })
  },

  goCities() {
    wx.navigateTo({ url: '/pages/cities/cities' })
  },

  goSettings() {
    wx.navigateTo({ url: '/pages/settings/settings' })
  },

  goRainDetail() {
    wx.navigateTo({ url: '/pages/rain/rain' })
  },

  goTwoWeekWeather() {
    wx.navigateTo({ url: `/pages/weather-week/weather-week?city=${encodeURIComponent(this.data.city)}` })
  },

  goNationalOverview() {
    const skyWindow = this.data.forecast && this.data.forecast.primaryWindow
    if (!skyWindow) return
    const targetAt = Number(skyWindow.solarAt || skyWindow.startAt)
    if (!Number.isFinite(targetAt)) return
    const query = `city=${encodeURIComponent(this.data.city)}&scene=${encodeURIComponent(skyWindow.kind || '')}&targetAt=${targetAt}`
    wx.navigateTo({ url: `/pages/model-map/model-map?${query}` })
  },

  goSkyDetail(event) {
    const { windowIndex } = event.currentTarget.dataset
    const query = `window=${Number(windowIndex) || 0}`
    wx.navigateTo({ url: `/pages/sky-detail/sky-detail?${query}` })
  },

  setNavigationMetrics() {
    const systemInfo = wx.getSystemInfoSync()
    const statusBarHeight = systemInfo.statusBarHeight || 20
    const fallbackMenu = {
      top: statusBarHeight + 6,
      height: 32,
      left: (systemInfo.windowWidth || 375) - 96
    }
    const menuButton = wx.getMenuButtonBoundingClientRect
      ? wx.getMenuButtonBoundingClientRect()
      : fallbackMenu
    const topGap = Math.max(menuButton.top - statusBarHeight, 6)

    this.setData({
      statusBarHeight,
      navContentHeight: topGap + menuButton.height,
      menuRightSpace: Math.max((systemInfo.windowWidth || 375) - menuButton.left + 10, 96)
    })
  }
})
