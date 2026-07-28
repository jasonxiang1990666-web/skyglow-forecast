App({
  onLaunch() {
    if (wx.cloud) {
      wx.cloud.init({
        env: wx.cloud.DYNAMIC_CURRENT_ENV,
        traceUser: true
      })
    }
    this.checkForUpdate()
  },

  checkForUpdate() {
    if (!wx.getUpdateManager) return

    const updateManager = wx.getUpdateManager()
    updateManager.onUpdateReady(() => {
      wx.showModal({
        title: '发现新版本',
        content: '新版本已准备好，点击“立即更新”后将自动重启。',
        confirmText: '立即更新',
        cancelText: '稍后',
        success: (result) => {
          if (result.confirm) updateManager.applyUpdate()
        }
      })
    })

    updateManager.onUpdateFailed(() => {
      wx.showToast({
        title: '新版本下载失败，请稍后重试',
        icon: 'none'
      })
    })
  },
  globalData: {
    defaultCity: '杭州'
  }
})
