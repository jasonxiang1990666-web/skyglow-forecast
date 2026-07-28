const { getNext24HourForecast } = require('../../services/weather')
const { withWarningRainFallback } = require('../../utils/rain')

Page({
  data: {
    city: '杭州',
    forecast: null,
    loading: true,
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

  loadForecast(city) {
    this.setData({ loading: true })
    getNext24HourForecast(city)
      .then((forecast) => this.setData({ forecast: withWarningRainFallback(forecast), loading: false }))
      .catch(() => {
        this.setData({ loading: false })
        wx.showToast({ title: '天气数据加载失败', icon: 'none' })
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
