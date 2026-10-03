/**
 * 🧠 KutBeyin — Condition Evaluator
 * 
 * JSON koşulları güvenli SQL sorgusuna çevirir.
 * SQL enjeksiyon riskini sıfırlar — sadece izin verilen alanlar sorgulanabilir.
 * 
 * Örnek JSON koşul:
 * {
 *   "logic": "AND",
 *   "rules": [
 *     { "field": "is_setup_completed", "op": "=", "value": 1 },
 *     { "field": "days_since_signup", "op": ">=", "value": 3 }
 *   ]
 * }
 */

const db = require('../config/db');

// ══════════════════════════════════════════════════════════════════
// İzin verilen alanlar ve bunların SQL karşılıkları
// Bu alanlar dışında bir koşul yazılamaz!
// ══════════════════════════════════════════════════════════════════

const RESTAURANT_FIELDS = {
  // Temel bilgiler
  days_since_signup: 'DATEDIFF(NOW(), r.created_at)',
  is_setup_completed: 'r.is_setup_completed',
  hours_since_setup_completed: 'TIMESTAMPDIFF(HOUR, r.updated_at, NOW())',
  
  // Ürün / Menü
  product_count: '(SELECT COUNT(*) FROM products p WHERE p.restaurant_id = r.id)',
  
  // Logo
  has_logo: '(CASE WHEN sc.logo_url IS NOT NULL AND sc.logo_url != \'\' THEN 1 ELSE 0 END)',
  
  // Çalışma saatleri
  has_working_hours: '(SELECT CASE WHEN COUNT(*) > 0 THEN 1 ELSE 0 END FROM restaurant_working_hours rwh WHERE rwh.restaurant_id = r.id)',
  
  // Teslimat bölgeleri
  has_delivery_zones: '(SELECT CASE WHEN COUNT(*) > 0 THEN 1 ELSE 0 END FROM restaurant_delivery_zones rdz WHERE rdz.restaurant_id = r.id)',
  
  // Sipariş
  total_orders: '(SELECT COUNT(*) FROM orders o WHERE o.restaurant_id = r.id)',
  days_since_last_order: `COALESCE(DATEDIFF(NOW(), (SELECT MAX(o.order_time) FROM orders o WHERE o.restaurant_id = r.id)), 9999)`,
  
  // Abonelik
  subscription_status: '(SELECT sub.status FROM subscriptions sub WHERE sub.restaurant_id = r.id ORDER BY sub.id DESC LIMIT 1)',
  days_since_expiry: `COALESCE(DATEDIFF(NOW(), (SELECT sub.expires_at FROM subscriptions sub WHERE sub.restaurant_id = r.id AND sub.status = 'expired' ORDER BY sub.id DESC LIMIT 1)), 0)`,
  order_counter: 'COALESCE((SELECT sub.order_counter FROM subscriptions sub WHERE sub.restaurant_id = r.id ORDER BY sub.id DESC LIMIT 1), 0)',
  trial_limit: 'COALESCE((SELECT sub.trial_order_limit FROM subscriptions sub WHERE sub.restaurant_id = r.id ORDER BY sub.id DESC LIMIT 1), 10)',
  
  // İptal oranı
  cancel_rate_7d: `COALESCE(
    (SELECT ROUND(
      SUM(CASE WHEN o.order_status = 'cancelled' THEN 1 ELSE 0 END) * 100.0 / NULLIF(COUNT(*), 0)
    , 1) FROM orders o WHERE o.restaurant_id = r.id AND o.order_time >= DATE_SUB(NOW(), INTERVAL 7 DAY)
    ), 0)`,
  
  // Online ödeme
  online_payment_enabled: 'COALESCE((SELECT rs.online_payment_enabled FROM restaurant_settings rs WHERE rs.restaurant_id = r.id LIMIT 1), 0)',
  
  // Kampanya
  campaign_count: '(SELECT COUNT(*) FROM coupons c WHERE c.restaurant_id = r.id)',
  
  // Müşteri sayısı
  unique_customer_count: '(SELECT COUNT(DISTINCT o.user_id) FROM orders o WHERE o.restaurant_id = r.id AND o.user_id IS NOT NULL)',
  
  // Panel giriş
  days_since_last_login: `COALESCE(DATEDIFF(NOW(), (SELECT MAX(st.last_login_date) FROM staff st WHERE st.restaurant_id = r.id)), 9999)`,
};

const CUSTOMER_FIELDS = {
  days_since_signup: 'DATEDIFF(NOW(), u.registration_date)',
  total_orders: '(SELECT COUNT(*) FROM orders o WHERE o.user_id = u.id AND o.restaurant_id = ?)',
  days_since_last_order: `COALESCE(DATEDIFF(NOW(), (SELECT MAX(o.order_time) FROM orders o WHERE o.user_id = u.id AND o.restaurant_id = ?)), 9999)`,
  cashback_balance: 'COALESCE((SELECT w.balance FROM user_wallets w WHERE w.user_id = u.id AND w.restaurant_id = ? LIMIT 1), 0)',
  loyalty_level: `COALESCE((SELECT ul.current_level FROM user_loyalty ul WHERE ul.user_id = u.id AND ul.restaurant_id = ? LIMIT 1), 0)`,
};

// İzin verilen operatörler
const ALLOWED_OPERATORS = ['=', '!=', '>', '<', '>=', '<=', 'IN', 'NOT IN', 'LIKE'];

/**
 * JSON koşullarını parse edip hedefleri bulan SQL sorgusu oluşturur
 * 
 * @param {Object} conditions - JSON koşul objesi
 * @param {string} targetType - 'restaurant' veya 'customer'
 * @param {number|null} restaurantId - Müşteri sorguları için restoran ID
 * @returns {Promise<Array>} Koşula uyan hedeflerin listesi
 */
async function evaluateConditions(conditions, targetType, restaurantId = null) {
  try {
    if (!conditions || !conditions.rules || !Array.isArray(conditions.rules)) {
      console.warn('[ConditionEvaluator] Geçersiz koşul formatı:', conditions);
      return [];
    }

    const logic = (conditions.logic || 'AND').toUpperCase();
    if (!['AND', 'OR'].includes(logic)) {
      console.warn('[ConditionEvaluator] Geçersiz logic operatörü:', logic);
      return [];
    }

    const fieldMap = targetType === 'restaurant' ? RESTAURANT_FIELDS : CUSTOMER_FIELDS;
    const whereClauses = [];
    const params = [];

    for (const rule of conditions.rules) {
      const { field, op, value } = rule;

      // Güvenlik: Alan ve operatör kontrolü
      if (!fieldMap[field]) {
        console.warn(`[ConditionEvaluator] Bilinmeyen alan: ${field} (target: ${targetType})`);
        continue;
      }

      if (!ALLOWED_OPERATORS.includes(op.toUpperCase())) {
        console.warn(`[ConditionEvaluator] İzin verilmeyen operatör: ${op}`);
        continue;
      }

      let sqlField = fieldMap[field];

      // Müşteri sorgularında restaurant_id placeholder'ını doldur
      if (targetType === 'customer' && sqlField.includes('?')) {
        const placeholderCount = (sqlField.match(/\?/g) || []).length;
        for (let i = 0; i < placeholderCount; i++) {
          sqlField = sqlField.replace('?', restaurantId);
        }
      }

      // IN operatörü için özel işlem
      if (op.toUpperCase() === 'IN' || op.toUpperCase() === 'NOT IN') {
        if (Array.isArray(value)) {
          const placeholders = value.map(() => '?').join(', ');
          whereClauses.push(`(${sqlField}) ${op} (${placeholders})`);
          params.push(...value);
        }
      } else {
        whereClauses.push(`(${sqlField}) ${op} ?`);
        params.push(value);
      }
    }

    if (whereClauses.length === 0) {
      console.warn('[ConditionEvaluator] Hiçbir geçerli koşul bulunamadı.');
      return [];
    }

    const whereSQL = whereClauses.join(` ${logic} `);

    let fullQuery;
    if (targetType === 'restaurant') {
      fullQuery = `
        SELECT r.id AS target_id, r.id AS restaurant_id, r.slug,
               COALESCE(sc.business_name, r.name) AS target_name,
               (SELECT st.phone FROM staff st WHERE st.restaurant_id = r.id AND st.role = 'admin' LIMIT 1) AS phone,
               (SELECT COUNT(*) FROM orders o WHERE o.restaurant_id = r.id) AS total_orders,
               (SELECT COUNT(DISTINCT o.user_id) FROM orders o WHERE o.restaurant_id = r.id AND o.user_id IS NOT NULL) AS unique_customer_count,
               (SELECT COUNT(*) FROM orders o WHERE o.restaurant_id = r.id AND o.order_time >= DATE_SUB(NOW(), INTERVAL 7 DAY)) AS orders,
               COALESCE((SELECT SUM(o.total_amount) FROM orders o WHERE o.restaurant_id = r.id AND o.order_time >= DATE_SUB(NOW(), INTERVAL 7 DAY)), 0) AS revenue,
               (SELECT COUNT(DISTINCT o.user_id) FROM orders o WHERE o.restaurant_id = r.id AND o.order_time >= DATE_SUB(NOW(), INTERVAL 7 DAY) AND o.user_id NOT IN (SELECT DISTINCT o2.user_id FROM orders o2 WHERE o2.restaurant_id = r.id AND o2.order_time < DATE_SUB(NOW(), INTERVAL 7 DAY) AND o2.user_id IS NOT NULL)) AS new_customers,
               (SELECT COUNT(*) FROM orders o WHERE o.restaurant_id = r.id AND o.order_time >= DATE_SUB(NOW(), INTERVAL 14 DAY) AND o.order_time < DATE_SUB(NOW(), INTERVAL 7 DAY)) AS last_week_orders,
               ${RESTAURANT_FIELDS.cancel_rate_7d} AS rate
        FROM restaurants r
        LEFT JOIN setup_config sc ON r.id = sc.restaurant_id
        WHERE ${whereSQL}
      `;
    } else {
      // customer — belirli bir restoranın müşterileri
      fullQuery = `
        SELECT u.id AS target_id, ${restaurantId} AS restaurant_id,
               u.full_name AS target_name,
               u.phone AS phone,
               COALESCE((SELECT w.balance FROM user_wallets w WHERE w.user_id = u.id AND w.restaurant_id = ${restaurantId} LIMIT 1), 0) AS balance,
               (SELECT COUNT(*) FROM orders o WHERE o.user_id = u.id AND o.restaurant_id = ${restaurantId}) AS total_orders,
               COALESCE((SELECT ul.current_level FROM user_loyalty ul WHERE ul.user_id = u.id AND ul.restaurant_id = ${restaurantId} LIMIT 1), 0) AS loyalty_level
        FROM users u
        WHERE EXISTS (SELECT 1 FROM orders o WHERE o.user_id = u.id AND o.restaurant_id = ${restaurantId})
        AND ${whereSQL}
      `;
    }

    const [results] = await db.promise().query(fullQuery, params);
    return Array.isArray(results) ? results : [];

  } catch (error) {
    console.error('[ConditionEvaluator] Hata:', error.message);
    return [];
  }
}

const EVENT_FIELD_ALIASES = {
  subscription_status: ['status', 'subscriptionStatus', 'subscription_status'],
  days_since_signup: ['daysSinceSignup', 'days_since_signup'],
  days_since_expiry: ['daysSinceExpiry', 'days_since_expiry'],
  product_count: ['productCount', 'product_count'],
  order_counter: ['orderCount', 'orderCounter', 'order_counter', 'total_orders', 'totalOrders'],
  total_orders: ['orderCount', 'totalOrders', 'total_orders', 'order_counter', 'orderCounter'],
  cancel_rate_7d: ['cancelRate7d', 'cancel_rate_7d'],
  online_payment_enabled: ['onlinePaymentEnabled', 'online_payment_enabled'],
  campaign_count: ['campaignCount', 'campaign_count'],
  unique_customer_count: ['uniqueCustomerCount', 'unique_customer_count'],
  days_since_last_login: ['daysSinceLastLogin', 'days_since_last_login'],
  cashback_balance: ['balance', 'cashbackBalance', 'cashback_balance'],
  loyalty_level: ['level', 'loyaltyLevel', 'loyalty_level', 'current_level', 'currentLevel']
};

/**
 * Tek bir hedef için koşulları kontrol eder (event tabanlı kurallar için)
 * 
 * @param {Object} conditions - JSON koşul objesi
 * @param {Object} eventData - Event verileri (orderCount, subscriptionStatus vb.)
 * @returns {boolean} Koşullar sağlanıyor mu?
 */
function evaluateEventConditions(conditions, eventData) {
  try {
    if (!conditions || !conditions.rules || !Array.isArray(conditions.rules)) {
      return true; // Koşul yoksa her zaman geçerli
    }

    const logic = (conditions.logic || 'AND').toUpperCase();
    if (!['AND', 'OR'].includes(logic)) {
      console.warn('[ConditionEvaluator] Geçersiz event logic operatörü:', logic);
      return false;
    }
    const results = [];

    for (const rule of conditions.rules) {
      const { field, op, value } = rule;
      let actual = eventData[field];

      if (actual === undefined && EVENT_FIELD_ALIASES[field]) {
        // Değer undefined ise alternatif alias alanlarını kontrol et
        for (const alias of EVENT_FIELD_ALIASES[field]) {
          if (eventData[alias] !== undefined) {
            actual = eventData[alias];
            break;
          }
        }
      }

      if (actual === undefined) {
        results.push(false);
        continue;
      }

      let result = false;
      switch (op) {
        case '=':  result = actual == value; break;
        case '!=': result = actual != value; break;
        case '>':  result = actual > value; break;
        case '<':  result = actual < value; break;
        case '>=': result = actual >= value; break;
        case '<=': result = actual <= value; break;
        case 'IN': result = Array.isArray(value) && value.includes(actual); break;
        case 'NOT IN': result = Array.isArray(value) && !value.includes(actual); break;
        default: result = false;
      }
      results.push(result);
    }

    if (results.length === 0) return true;

    return logic === 'AND'
      ? results.every(r => r === true)
      : results.some(r => r === true);

  } catch (error) {
    console.error('[ConditionEvaluator] Event koşul hatası:', error.message);
    return false;
  }
}

module.exports = {
  evaluateConditions,
  evaluateEventConditions,
  RESTAURANT_FIELDS,
  CUSTOMER_FIELDS,
  ALLOWED_OPERATORS
};
