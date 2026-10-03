/**
 * refundService.js — İade İş Mantığı Katmanı
 * 
 * Single Responsibility: Yalnızca iyzico iade sürecini yönetir.
 * Open/Closed: Yeni iade türleri (PARTIAL) kolayca eklenebilir.
 * DRY: Admin iptal, kullanıcı iptal ve manuel iade tek noktadan geçer.
 * 
 * Dependency: iyzicoService (API), paymentService (credential), db (veri).
 */
const db = require('../config/db');
const { logPaymentEvent } = require('../utils/paymentLogger');

class RefundService {

  /**
   * İyzico ödemesi için iade işlemi yapar.
   * Tüm iade senaryoları (admin iptal, kullanıcı iptal, manuel iade) bu metodu kullanır.
   *
   * @param {Object} params
   * @param {number}        params.paymentTransactionId - payment_transactions.id
   * @param {number}        params.restaurantId
   * @param {number|null}   [params.orderId]    - İlgili sipariş ID
   * @param {number|null}   [params.refundedBy] - İşlemi yapan kullanıcı ID
   * @param {string}        [params.reason]     - İade nedeni
   * @param {number|null}   [params.amount]     - Kısmi iade tutarı (null = tam iade)
   * @param {Function|null} [params.queryFn]    - Transaction desteği: (sql, params) => Promise<[rows]>
   * @returns {Promise<{status, refundId, refundAmount, refundType, message}>}
   */
  async processRefund({
    paymentTransactionId,
    restaurantId,
    orderId = null,
    refundedBy = null,
    reason = 'İade',
    amount = null,
    queryFn = null
  }) {
    const runQuery = queryFn || ((sql, params) => db.promise().query(sql, params));

    // 1. Ödeme kaydını doğrula
    const paymentTx = await this._getPaymentTransaction(runQuery, paymentTransactionId, restaurantId);

    // 2. Önceki başarılı iadeleri kontrol et (çifte iade engeli)
    const paidAmount = parseFloat(paymentTx.paid_amount);
    const previousRefunds = await this._getPreviousRefundTotal(runQuery, paymentTransactionId);
    const remainingAmount = paidAmount - previousRefunds;

    if (remainingAmount <= 0) {
      throw new Error('Bu ödemenin tamamı zaten iade edilmiş.');
    }

    // 3. İade tutarını ve tipini belirle
    const refundAmount = amount != null ? parseFloat(amount) : remainingAmount;
    const refundType = refundAmount >= remainingAmount ? 'FULL' : 'PARTIAL';

    this._validateRefundAmount(refundAmount, remainingAmount);

    // 3. Restoranın iyzico servisini al
    const paymentService = require('./paymentService');
    const iyzicoService = await paymentService._getIyzicoServiceForRestaurant(restaurantId);

    // 4. İyzico'dan kalem bazlı fiyatları al (doğru iade tutarları için)
    const itemDetails = await this._resolveItemDetails(iyzicoService, paymentTx);

    // 5. İyzico refund API çağrısı
    const refundResults = await this._executeRefunds(iyzicoService, itemDetails, refundAmount, paidAmount, paymentTx);
    const allSuccess = refundResults.every(r => r.success);

    // 6. DB kayıtları
    const refundId = await this._recordRefund(runQuery, {
      paymentTransactionId: paymentTx.id,
      restaurantId,
      orderId: orderId || paymentTx.order_id,
      iyzicoPaymentId: paymentTx.iyzico_payment_id,
      refundAmount,
      refundType,
      status: allSuccess ? 'SUCCESS' : 'FAILURE',
      refundedBy,
      reason
    });

    // 7. Tam iade başarılıysa transaction durumunu güncelle
    if (allSuccess && refundType === 'FULL') {
      await runQuery(
        "UPDATE payment_transactions SET status = 'REFUNDED' WHERE id = ?",
        [paymentTx.id]
      );
    }

    // 8. Audit log
    logPaymentEvent({
      paymentTransactionId: paymentTx.id,
      restaurantId,
      eventType: allSuccess ? 'REFUND_SUCCESS' : 'REFUND_FAILURE',
      eventDescription: `İade ${allSuccess ? 'başarılı' : 'başarısız'}: ${refundAmount} TRY (${refundType})`,
      eventData: { refundId, refundAmount, refundType, itemCount: itemDetails.length },
      source: refundedBy ? 'ADMIN' : 'SYSTEM'
    });

    return {
      status: allSuccess ? 'SUCCESS' : 'FAILURE',
      refundId,
      refundAmount,
      refundType,
      message: allSuccess
        ? `${refundAmount} TL başarıyla iade edildi.`
        : 'İade sırasında bir sorun oluştu, lütfen tekrar deneyin.'
    };
  }

  // ─── Private: Ödeme Kaydı Doğrulama ───────────────────────

  async _getPaymentTransaction(runQuery, id, restaurantId) {
    const [rows] = await runQuery(
      `SELECT id, order_id, iyzico_payment_id, iyzico_payment_transaction_id,
              paid_amount, amount, status
       FROM payment_transactions
       WHERE id = ? AND restaurant_id = ?`,
      [id, restaurantId]
    );

    if (!rows.length) {
      throw new Error('Ödeme kaydı bulunamadı.');
    }

    const tx = rows[0];

    if (tx.status === 'REFUNDED') {
      throw new Error('Bu ödeme zaten iade edilmiş.');
    }
    if (tx.status !== 'SUCCESS') {
      throw new Error(`Bu ödeme iade edilemez (mevcut durum: ${tx.status}).`);
    }
    if (!tx.iyzico_payment_id) {
      throw new Error('İyzico ödeme ID bulunamadı.');
    }

    return tx;
  }

  _validateRefundAmount(refundAmount, maxAmount) {
    if (refundAmount <= 0) {
      throw new Error('İade tutarı sıfırdan büyük olmalıdır.');
    }
    if (refundAmount > maxAmount + 0.01) { // küçük yuvarlama toleransı
      throw new Error(`İade tutarı en fazla ${maxAmount.toFixed(2)} TL olabilir.`);
    }
  }

  /**
   * Bir ödeme için daha önce yapılmış başarılı iadelerin toplam tutarını döner.
   */
  async _getPreviousRefundTotal(runQuery, paymentTransactionId) {
    const [rows] = await runQuery(
      `SELECT COALESCE(SUM(refund_amount), 0) AS total_refunded
       FROM payment_refunds
       WHERE payment_transaction_id = ? AND status = 'SUCCESS'`,
      [paymentTransactionId]
    );
    return parseFloat(rows[0]?.total_refunded || 0);
  }

  // ─── Private: Kalem Detayları ─────────────────────────────

  /**
   * İyzico'dan her kalemin gerçek fiyatını alır.
   * Başarısız olursa DB'deki kayıtlı verilerle fallback yapar.
   */
  async _resolveItemDetails(iyzicoService, paymentTx) {
    // Öncelik 1: iyzico'dan canlı veri çek (en doğru fiyatlar)
    try {
      const paymentDetail = await iyzicoService.retrievePayment(paymentTx.iyzico_payment_id);

      if (paymentDetail.status === 'success' && paymentDetail.itemTransactions?.length) {
        console.log(`[REFUND] iyzico'dan ${paymentDetail.itemTransactions.length} kalem detayı alındı.`);
        return paymentDetail.itemTransactions.map(it => ({
          paymentTransactionId: it.paymentTransactionId,
          paidPrice: parseFloat(it.paidPrice)
        }));
      }
    } catch (err) {
      console.warn('[REFUND] iyzico payment.retrieve başarısız, kayıtlı veriler kullanılacak:', err.message);
    }

    // Öncelik 2: DB'deki kayıtlı transaction ID'leri (fallback)
    return this._parseStoredItemTransactions(paymentTx);
  }

  _parseStoredItemTransactions(paymentTx) {
    let ids = [];
    try {
      ids = JSON.parse(paymentTx.iyzico_payment_transaction_id || '[]');
    } catch {
      console.warn('[REFUND] iyzico_payment_transaction_id parse hatası.');
    }

    // Son çare: paymentId'yi tek kalemli fallback olarak kullan
    if (ids.length === 0 && paymentTx.iyzico_payment_id) {
      ids = [paymentTx.iyzico_payment_id];
    }

    if (ids.length === 0) {
      throw new Error('İade için gerekli iyzico transaction ID bulunamadı.');
    }

    // Fiyat bilgisi yoksa eşit dağıt
    const perItemPrice = parseFloat(paymentTx.paid_amount) / ids.length;
    return ids.map(id => ({
      paymentTransactionId: id,
      paidPrice: perItemPrice
    }));
  }

  // ─── Private: İyzico Refund Çağrıları ─────────────────────

  async _executeRefunds(iyzicoService, itemDetails, totalRefundAmount, totalPaidAmount, paymentTx) {
    const isFullRefund = totalRefundAmount >= totalPaidAmount;
    const results = [];

    for (const item of itemDetails) {
      // Tam iade: her kalemin kendi fiyatını iade et
      // Kısmi iade: toplam iade tutarını oransal dağıt
      const itemRefundPrice = isFullRefund
        ? item.paidPrice.toFixed(2)
        : ((item.paidPrice / totalPaidAmount) * totalRefundAmount).toFixed(2);

      try {
        const result = await iyzicoService.refund({
          locale: 'tr',
          conversationId: `REFUND-${paymentTx.order_id || paymentTx.id}-${Date.now()}`,
          paymentTransactionId: item.paymentTransactionId,
          price: itemRefundPrice,
          currency: 'TRY',
          ip: '127.0.0.1'
        });

        const success = result.status === 'success';
        console.log(`[REFUND] Kalem ${item.paymentTransactionId}: ${itemRefundPrice} TRY → ${success ? '✅' : '❌'}`);

        if (!success) {
          console.error(`[REFUND] iyzico hata:`, result.errorMessage || result.errorCode);
        }

        results.push({ txId: item.paymentTransactionId, success, amount: itemRefundPrice });
      } catch (err) {
        console.error(`[REFUND] Kalem ${item.paymentTransactionId} exception:`, err.message);
        results.push({ txId: item.paymentTransactionId, success: false, error: err.message });
      }
    }

    return results;
  }

  // ─── Private: DB Kaydı ────────────────────────────────────

  async _recordRefund(runQuery, { paymentTransactionId, restaurantId, orderId, iyzicoPaymentId, refundAmount, refundType, status, refundedBy, reason }) {
    const [result] = await runQuery(
      `INSERT INTO payment_refunds
       (payment_transaction_id, restaurant_id, order_id, iyzico_payment_id, refund_amount, refund_type, status, refunded_by, refund_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [paymentTransactionId, restaurantId, orderId, iyzicoPaymentId, refundAmount, refundType, status, refundedBy, reason]
    );
    return result.insertId;
  }
}

module.exports = new RefundService();
