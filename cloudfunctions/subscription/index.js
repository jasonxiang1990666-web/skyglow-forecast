const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

function preferenceData(event) {
  const city = String(event.city || '杭州').trim().slice(0, 20) || '杭州'
  return {
    city,
    onlyHighProbability: event.onlyHighProbability !== false,
    rainReminder: event.rainReminder !== false
  }
}

async function findSubscription(openid) {
  const result = await db.collection('subscriptions').where({ openid }).limit(1).get()
  return result.data[0] || null
}

exports.main = async (event) => {
  const { OPENID: openid } = cloud.getWXContext()
  if (!openid) throw new Error('无法识别微信用户')

  const action = event.action || 'status'
  const existing = await findSubscription(openid)

  if (action === 'status') {
    return existing
      ? {
          exists: true,
          active: Boolean(existing.enabled && existing.remainingQuota > 0),
          city: existing.city,
          onlyHighProbability: existing.onlyHighProbability !== false,
          rainReminder: existing.rainReminder !== false
        }
      : { exists: false, active: false }
  }

  if (action === 'grant') {
    const data = {
      openid,
      ...preferenceData(event),
      enabled: true,
      remainingQuota: 1,
      subscribedAt: db.serverDate(),
      updatedAt: db.serverDate()
    }
    if (existing) await db.collection('subscriptions').doc(existing._id).update({ data })
    else await db.collection('subscriptions').add({ data })
    return { ok: true, active: true }
  }

  if (action === 'update') {
    if (!existing) return { ok: true, exists: false }
    const enabled = event.enabled === false ? false : existing.enabled
    await db.collection('subscriptions').doc(existing._id).update({
      data: { ...preferenceData(event), enabled, updatedAt: db.serverDate() }
    })
    return { ok: true, active: Boolean(enabled && existing.remainingQuota > 0) }
  }

  throw new Error('不支持的订阅操作')
}
