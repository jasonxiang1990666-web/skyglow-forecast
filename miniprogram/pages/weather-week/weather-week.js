const { getTwoWeekWeatherForecast } = require('../../services/weather')

Page({
  data: {
    city: '',
    days: [],
    updatedAt: '',
    loading: true,
    loadError: ''
  },

  onLoad(options) {
    this.city = decodeURIComponent(options.city || wx.getStorageSync('selectedCity') || getApp().globalData.defaultCity)
    this.loadForecast()
  },

  onPullDownRefresh() {
    this.loadForecast(true)
  },

  loadForecast(fromPullDown = false) {
    if (!fromPullDown) this.setData({ loading: true, loadError: '' })
    getTwoWeekWeatherForecast(this.city)
      .then((forecast) => {
        this.setData({
          city: forecast.city || this.city,
          days: forecast.days,
          updatedAt: forecast.updatedAt,
          loading: false,
          loadError: ''
        })
      })
      .catch(() => {
        this.setData({
          loading: false,
          loadError: '暂时无法加载未来两周天气，请稍后重试。'
        })
      })
      .finally(() => {
        if (fromPullDown) wx.stopPullDownRefresh()
      })
  },

  retry() {
    this.loadForecast()
  }
})
