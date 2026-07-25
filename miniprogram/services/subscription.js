const SUBSCRIBE_TEMPLATE_ID = 'C7KsBELQ6RneIUbptlCEoNPvg5B9tHOY5nCkhTOpQG4'

function callSubscription(action, data = {}) {
  return wx.cloud.callFunction({
    name: 'subscription',
    data: { action, ...data }
  }).then((response) => response.result)
}

function requestTomorrowReminder() {
  return new Promise((resolve, reject) => {
    wx.requestSubscribeMessage({
      tmplIds: [SUBSCRIBE_TEMPLATE_ID],
      success: (response) => resolve({ response }),
      fail: reject
    })
  })
}

function saveGrantedReminder(preferences) {
  return callSubscription('grant', preferences)
}

function syncReminderPreferences(preferences) {
  return callSubscription('update', preferences)
}

function getReminderStatus() {
  return callSubscription('status')
}

module.exports = {
  SUBSCRIBE_TEMPLATE_ID,
  requestTomorrowReminder,
  saveGrantedReminder,
  syncReminderPreferences,
  getReminderStatus
}
