const { getNext24HourForecast } = require('../../services/weather')
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
    const isManual = wx.getStorageSync('selectedCitySource') === 'manual'
    const displayCity = isManual ? city : (wx.getStorageSync('selectedLocationLabel') || city)
    this.setData({ city: displayCity })
    if (isManual) {
      this.loadForecast(city)
      return
    }
    this.loadForecastFromCurrentLocation(city)
  },

  onHide() {
    this.stopSolarCountdown()
  },

  onUnload() {
    this.stopSolarCountdown()
  },

  loadForecastFromCurrentLocation(fallbackCity) {
    const fallback = () => this.loadForecast(fallbackCity)
    wx.getSetting({
      success: (settings) => {
        if (settings.authSetting && settings.authSetting['scope.userLocation'] === false) {
          fallback()
          return
        }
        wx.getLocation({
          type: 'gcj02',
          success: (coordinates) => {
            wx.setStorageSync('selectedCoordinates', coordinates)
            wx.setStorageSync('selectedCitySource', 'gps')
            // 先用逆地理编码确定“城市 · 区县”，再请求天气，避免首页只显示区县名。
            wx.cloud.callFunction({
              name: 'forecast',
              data: { action: 'resolveLocation', latitude: coordinates.latitude, longitude: coordinates.longitude }
            }).then((response) => {
              const result = response.result || {}
              const resolvedCity = result.city || fallbackCity
              wx.setStorageSync('selectedCity', resolvedCity)
              wx.setStorageSync('selectedLocationLabel', result.locationLabel || resolvedCity)
              this.loadForecast(resolvedCity, coordinates)
            }).catch(() => this.loadForecast(fallbackCity, coordinates))
          },
          fail: fallback
        })
      },
      fail: fallback
    })
  },

  loadForecast(city, coordinates = {}) {
    this.setData({ loading: true })
    getNext24HourForecast(city, coordinates)
      .then((forecast) => {
        const normalizedForecast = withWarningRainFallback(forecast)
        const resolvedCity = normalizedForecast.city || city
        const displayLocation = normalizedForecast.locationLabel || resolvedCity
        wx.setStorageSync('selectedCity', resolvedCity)
        this.setData({ forecast: normalizedForecast, city: displayLocation, loading: false })
        this.startSolarCountdown()
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
    const city = (this.data.forecast && this.data.forecast.city) || wx.getStorageSync('selectedCity') || this.data.city
    wx.navigateTo({ url: `/pages/weather-week/weather-week?city=${encodeURIComponent(city)}` })
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
