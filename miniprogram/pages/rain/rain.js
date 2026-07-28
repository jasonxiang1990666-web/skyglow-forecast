const { getNext24HourForecast } = require('../../services/weather')
const { withWarningRainFallback } = require('../../utils/rain')

Page({
  data: {
    city: '',
    rain: null,
    updatedAt: '',
    loading: true
  },

  onShow() {
    const city = wx.getStorageSync('selectedCity') || getApp().globalData.defaultCity
    this.setData({ city })
    this.loadRain(city)
  },

  loadRain(city) {
    this.setData({ loading: true })
    getNext24HourForecast(city)
      .then((forecast) => {
        const view = withWarningRainFallback(forecast)
        this.setData({
          rain: view.shortRain || null,
          updatedAt: view.updatedAt,
          loading: false
        })
      })
      .catch(() => {
        this.setData({ loading: false })
        wx.showToast({ title: '天气数据加载失败', icon: 'none' })
      })
  }
})
