const {
  SUBSCRIBE_TEMPLATE_ID,
  requestTomorrowReminder,
  saveGrantedReminder,
  syncReminderPreferences,
  getReminderStatus
} = require('../../services/subscription')

Page({
  data: {
    skyReminder: false,
    onlyHighProbability: true,
    rainReminder: true,
    city: '杭州'
  },

  onShow() {
    const local = {
      skyReminder: wx.getStorageSync('skyReminder') || false,
      onlyHighProbability: wx.getStorageSync('onlyHighProbability') !== false,
      rainReminder: wx.getStorageSync('rainReminder') !== false,
      city: wx.getStorageSync('selectedCity') || getApp().globalData.defaultCity
    }
    this.setData(local)

    getReminderStatus().then((status) => {
      if (!status.exists) return
      const preferences = {
        city: local.city,
        onlyHighProbability: status.onlyHighProbability,
        rainReminder: status.rainReminder
      }
      wx.setStorageSync('skyReminder', status.active)
      wx.setStorageSync('onlyHighProbability', status.onlyHighProbability)
      wx.setStorageSync('rainReminder', status.rainReminder)
      this.setData({ ...preferences, skyReminder: status.active })
      if (status.active && status.city !== local.city) {
        syncReminderPreferences({ ...preferences, enabled: true }).catch(() => {})
      }
    }).catch(() => {})
  },

  async onSkyReminderChange(event) {
    const enabled = event.detail.value
    if (!enabled) {
      wx.setStorageSync('skyReminder', false)
      this.setData({ skyReminder: false })
      syncReminderPreferences({ ...this.data, enabled: false }).catch(() => {})
      return
    }

    let response
    try {
      response = (await requestTomorrowReminder()).response
    } catch (error) {
      console.error('[订阅授权失败]', error)
      this.setData({ skyReminder: false })
      wx.showModal({
        title: '订阅授权失败',
        content: String(error.errMsg || error.message || '未知错误'),
        showCancel: false
      })
      return
    }

    if (response[SUBSCRIBE_TEMPLATE_ID] !== 'accept') {
      console.warn('[订阅授权未允许]', response)
      this.setData({ skyReminder: false })
      wx.showToast({ title: '请在微信弹窗中选择允许', icon: 'none' })
      return
    }

    try {
      await saveGrantedReminder({
        city: this.data.city,
        onlyHighProbability: this.data.onlyHighProbability,
        rainReminder: this.data.rainReminder
      })
      wx.setStorageSync('skyReminder', true)
      this.setData({ skyReminder: true })
      wx.showToast({ title: '已订阅下一次提醒', icon: 'none' })
    } catch (error) {
      console.error('[订阅记录保存失败]', error)
      this.setData({ skyReminder: false })
      wx.showToast({ title: '授权成功，但保存提醒失败', icon: 'none' })
    }
  },

  onOnlyHighChange(event) {
    const onlyHighProbability = event.detail.value
    wx.setStorageSync('onlyHighProbability', onlyHighProbability)
    this.setData({ onlyHighProbability })
    if (this.data.skyReminder) {
      syncReminderPreferences({ ...this.data, onlyHighProbability, enabled: true }).catch(() => {})
    }
  },

  onRainReminderChange(event) {
    const rainReminder = event.detail.value
    wx.setStorageSync('rainReminder', rainReminder)
    this.setData({ rainReminder })
    if (this.data.skyReminder) {
      syncReminderPreferences({ ...this.data, rainReminder, enabled: true }).catch(() => {})
    }
  },

  goCities() {
    wx.navigateTo({ url: '/pages/cities/cities' })
  }
})
