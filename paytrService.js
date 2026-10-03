const crypto = require('crypto');

/**
 * PayTR API istekleri için güvenli token (hash) oluşturur.
 * @param {Array} data - Token oluşturulacak veri dizisi (belirli bir sırada olmalı)
 * @param {string} merchantSalt - PayTR Mağaza Parolası
 * @returns {string} paytrToken - Base64 kodlanmış HMAC-SHA256 imzası
 */
const generatePaytrToken = (data, merchantKey) => {
    try {
        // PayTR'nin istediği sıralama ile verileri birleştiriyoruz
        const hashString = data.join('');
        
        // HMAC-SHA256 ile imzalıyoruz (Anahtar: merchantKey)
        const paytrToken = crypto
            .createHmac('sha256', merchantKey)
            .update(hashString)
            .digest('base64');
            
        return paytrToken;
    } catch (error) {
        console.error('PayTR Token Oluşturma Hatası:', error);
        throw error;
    }
};

/**
 * PayTR'den gelen bildirimin doğruluğunu kontrol eder.
 * @param {object} params - PayTR'den gelen POST gövdesi
 * @param {string} merchantKey - PayTR Mağaza Anahtarı
 * @param {string} merchantSalt - PayTR Mağaza Parolası
 * @returns {boolean} - Hash doğrulanmışsa true döner
 */
const verifyPaytrHash = (params, merchantKey, merchantSalt) => {
    try {
        const { hash, merchant_oid, status, total_amount } = params;
        
        // PayTR Bildirim Hash Formülü: merchant_oid + merchant_salt + status + total_amount
        const hashString = merchant_oid + merchantSalt + status + total_amount;
        
        const calculatedHash = crypto
            .createHmac('sha256', merchantKey)
            .update(hashString)
            .digest('base64');
            
        return calculatedHash === hash;
    } catch (error) {
        console.error('PayTR Hash Doğrulama Hatası:', error);
        return false;
    }
};

module.exports = { 
    generatePaytrToken,
    verifyPaytrHash
};
