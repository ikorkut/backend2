/**
 * KutBeyin — Web Push Notification Servisi
 * 
 * PWA müşterilerine push notification gönderir.
 * VAPID kimlik doğrulaması kullanır.
 * Ücretsiz, sınırsız, anlık bildirim.
 */

const webpush = require('web-push');
const db = require('../config/db');

// ═════════════════════════════════════════════════════════════════
// VAPID Konfigürasyonu (.env'den okunur)
// ═════════════════════════════════════════════════════════════════
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || '';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || '';
const VAPID_EMAIL = process.env.VAPID_EMAIL || 'mailto:info@kutyemek.com';

const PUSH_ENABLED = !!(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY);

if (PUSH_ENABLED) {
  webpush.setVapidDetails(VAPID_EMAIL, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
  console.log('[PushService] ✅ Web Push aktif (VAPID key yüklendi)');
} else {
  console.log('[PushService] ⚠️ Web Push devre dışı (VAPID key eksik)');
}

/**
 * Push notification gönderir
 * 
 * @param {string} phone - Kullanıcının telefon numarası (subscription bulmak için)
 * @param {string} message - Bildirim mesajı
 * @param {Object} options - Ek seçenekler { title, icon, url, restaurantId }
 * @returns {Object} { success: boolean, channel: string, error?: string }
 */
async function sendPush(phone, message, options = {}) {
  if (!PUSH_ENABLED) {
    console.log(`[PushService] SIMULASYON -> ${phone}: ${message.substring(0, 80)}...`);
    return { success: false, channel: 'push', error: 'Push devre dışı (VAPID key eksik)' };
  }

  try {
    // Telefon numarasına ait aktif push aboneliklerini bul
    const cleanPhone = phone ? phone.replace(/[\s\-\(\)\+]/g, '').replace(/^0/, '') : '';
    
    const [subscriptions] = await db.promise().query(
      `SELECT ps.* FROM push_subscriptions ps
       INNER JOIN users u ON ps.user_id = u.id
       WHERE REPLACE(REPLACE(REPLACE(u.phone, ' ', ''), '-', ''), '+', '') LIKE ?
       AND ps.is_active = 1
       ORDER BY ps.updated_at DESC
       LIMIT 5`,
      [`%${cleanPhone}`]
    );

    if (!subscriptions || subscriptions.length === 0) {
      return { success: false, channel: 'push', error: 'Push aboneliği bulunamadı' };
    }

    const payload = JSON.stringify({
      title: options.title || 'KutYemek',
      body: message,
      icon: options.icon || '/icon.png',
      badge: '/icon.png',
      data: {
        url: options.url || '/',
        restaurantId: options.restaurantId || null,
        timestamp: Date.now()
      }
    });

    let sent = false;
    let lastError = null;

    for (const sub of subscriptions) {
      try {
        const pushSubscription = {
          endpoint: sub.endpoint,
          keys: {
            p256dh: sub.p256dh_key,
            auth: sub.auth_key
          }
        };

        await webpush.sendNotification(pushSubscription, payload, { TTL: 3600 });
        sent = true;
        console.log(`[PushService] ✅ Push gönderildi -> user:${sub.user_id}`);
      } catch (pushErr) {
        lastError = pushErr.message;

        // 410 Gone veya 404 = subscription artık geçersiz, sil
        if (pushErr.statusCode === 410 || pushErr.statusCode === 404) {
          await db.promise().query(
            'UPDATE push_subscriptions SET is_active = 0 WHERE id = ?',
            [sub.id]
          );
          console.log(`[PushService] ♻️ Geçersiz subscription silindi (ID: ${sub.id})`);
        } else {
          console.error(`[PushService] ❌ Push hatası (user:${sub.user_id}):`, pushErr.message);
        }
      }
    }

    if (sent) {
      return { success: true, channel: 'push' };
    }

    return { success: false, channel: 'push', error: lastError || 'Tüm push denemeleri başarısız' };

  } catch (error) {
    console.error('[PushService] ❌ Push servis hatası:', error.message);
    return { success: false, channel: 'push', error: error.message };
  }
}

/**
 * Push subscription kaydet (kullanıcı push izni verince çağrılır)
 */
async function saveSubscription(userId, restaurantId, subscription) {
  try {
    const { endpoint, keys } = subscription;

    // Aynı endpoint varsa güncelle, yoksa ekle
    await db.promise().query(
      `INSERT INTO push_subscriptions (user_id, restaurant_id, endpoint, p256dh_key, auth_key, is_active, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, NOW())
       ON DUPLICATE KEY UPDATE
         p256dh_key = VALUES(p256dh_key),
         auth_key = VALUES(auth_key),
         is_active = 1,
         user_id = VALUES(user_id),
         restaurant_id = VALUES(restaurant_id),
         updated_at = NOW()`,
      [userId, restaurantId, endpoint, keys.p256dh, keys.auth]
    );

    console.log(`[PushService] ✅ Subscription kaydedildi (user:${userId}, restaurant:${restaurantId})`);
    return { success: true };

  } catch (error) {
    console.error('[PushService] ❌ Subscription kayıt hatası:', error.message);
    return { success: false, error: error.message };
  }
}

/**
 * Push subscription sil (kullanıcı bildirimleri kapattığında)
 */
async function removeSubscription(endpoint) {
  try {
    await db.promise().query(
      'UPDATE push_subscriptions SET is_active = 0 WHERE endpoint = ?',
      [endpoint]
    );
    return { success: true };
  } catch (error) {
    console.error('[PushService] ❌ Subscription silme hatası:', error.message);
    return { success: false, error: error.message };
  }
}

/**
 * VAPID public key döndür (client'ın subscribe olması için gerekli)
 */
function getPublicKey() {
  return VAPID_PUBLIC_KEY;
}

module.exports = {
  sendPush,
  saveSubscription,
  removeSubscription,
  getPublicKey,
  PUSH_ENABLED
};
