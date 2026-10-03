/**
 * geocodingService.js — Google Maps Geocoding API Sarmalayıcı
 * 
 * Koordinat → Adres bileşenlerine çevirir (Reverse Geocoding).
 * Türkiye'ye özel normalizasyon yapar (Türkçe karakter, MAH/MAHALLESİ vb.)
 */

const axios = require('axios');

/**
 * Reverse Geocode — Koordinattan adres bileşenlerine çevirir
 * @param {number} lat - Enlem
 * @param {number} lng - Boylam
 * @returns {Object} { city, district, neighborhood, street, formattedAddress }
 */
async function reverseGeocode(lat, lng) {
    const apiKey = process.env.GOOGLE_MAPS_API_KEY;
    
    if (!apiKey) {
        throw new Error('GOOGLE_MAPS_API_KEY .env dosyasında tanımlı değil.');
    }
    
    // Türkiye sınır kontrolü (lat: 35-43, lng: 25-45)
    if (lat < 35 || lat > 43 || lng < 25 || lng > 45) {
        throw new Error('Koordinatlar Türkiye sınırları dışında.');
    }
    
    const url = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&language=tr&result_type=street_address|route|premise&key=${apiKey}`;
    
    let response = await axios.get(url, { timeout: 10000 });
    
    // Filtrelenmiş sonuç yoksa, filtresiz tekrar dene
    if (response.data.status === 'ZERO_RESULTS' || !response.data.results || response.data.results.length === 0) {
        const fallbackUrl = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&language=tr&key=${apiKey}`;
        response = await axios.get(fallbackUrl, { timeout: 10000 });
    }
    
    if (response.data.status !== 'OK') {
        console.error('Google Geocoding API hatası:', response.data.status, response.data.error_message);
        
        // --- DEVELOPMENT FALLBACK FOR BILLING ERROR ---
        if (response.data.status === 'REQUEST_DENIED' && (response.data.error_message || '').includes('Billing')) {
            console.log('⚠️ [Geocoding-Fallback] Google Maps Billing hatası algılandı. Local test için Şişli/İstanbul mock adresi dönülüyor...');
            return {
                city: 'İSTANBUL',
                district: 'ŞİŞLİ',
                neighborhood: 'ESENTEPE MAH.',
                street: 'Büyükdere Cad. No: 120',
                formattedAddress: 'Esentepe Mah, Büyükdere Cad. No:120, 34394 Şişli/İstanbul, Türkiye',
                _raw: { placeId: 'mock_place_id', types: ['street_address'] }
            };
        }
        
        throw new Error(`Geocoding API hatası: ${response.data.status}`);
    }
    
    return _normalizeAddress(response.data.results);
}

/**
 * Google API yanıtından Türkiye'ye özel adres bileşenlerini çıkarır
 * @param {Array} results - Google Geocoding API results dizisi
 * @returns {Object} { city, district, neighborhood, street, formattedAddress }
 */
function _normalizeAddress(results) {
    if (!results || results.length === 0) {
        throw new Error('Geocoding sonucu bulunamadı.');
    }
    
    // Birden fazla sonuç varsa en uygununu seç
    // Öncelik: ROOFTOP location_type > RANGE_INTERPOLATED > diğer
    // Sonra: street_address > premise > route
    let primaryResult = results[0];
    
    // 1. Önce ROOFTOP sonucu ara (en hassas bina seviyesi konum)
    const rooftopResult = results.find(r => 
        r.geometry && r.geometry.location_type === 'ROOFTOP' && 
        r.types && (r.types.includes('street_address') || r.types.includes('premise'))
    );
    
    if (rooftopResult) {
        primaryResult = rooftopResult;
    } else {
        // 2. ROOFTOP yoksa street_address > premise > route öncelikli seç
        const priorityTypes = ['street_address', 'premise', 'route'];
        for (const pType of priorityTypes) {
            const found = results.find(r => r.types && r.types.includes(pType));
            if (found) {
                primaryResult = found;
                break;
            }
        }
    }
    
    const components = primaryResult.address_components;
    const locationType = (primaryResult.geometry && primaryResult.geometry.location_type) || 'UNKNOWN';
    
    let city = '';
    let district = '';
    let neighborhood = '';
    let street = '';
    let streetNumber = '';
    
    for (const comp of components) {
        const types = comp.types;
        
        // İl (administrative_area_level_1)
        if (types.includes('administrative_area_level_1')) {
            city = comp.long_name;
        }
        
        // İlçe (administrative_area_level_2)
        if (types.includes('administrative_area_level_2')) {
            district = comp.long_name;
        }
        
        // Mahalle (neighborhood veya administrative_area_level_4)
        if (types.includes('neighborhood') || types.includes('administrative_area_level_4')) {
            // Daha spesifik olanı tercih et (neighborhood > administrative_area_level_4)
            if (!neighborhood || types.includes('neighborhood')) {
                neighborhood = comp.long_name;
            }
        }
        
        // Bazen mahalle sublocality olarak gelir
        if (types.includes('sublocality_level_1') || types.includes('sublocality')) {
            if (!neighborhood) {
                neighborhood = comp.long_name;
            }
        }
        
        // Sokak/Cadde (route)
        if (types.includes('route')) {
            street = comp.long_name;
        }
        
        // Bina numarası (street_number)
        if (types.includes('street_number')) {
            streetNumber = comp.long_name;
        }
    }
    
    // Türkçe büyük harf normalizasyonu
    city = city.toLocaleUpperCase('tr-TR');
    district = district.toLocaleUpperCase('tr-TR');
    
    // Mahalle normalizasyonu — "Mah." ekini koru ama büyük harfe çevir
    if (neighborhood) {
        neighborhood = neighborhood.toLocaleUpperCase('tr-TR');
    }
    
    // Bina numarasını temizle
    let binaNo = '';
    if (streetNumber) {
        binaNo = streetNumber.replace(/^(no[:\s]*)+/i, '').trim();
    }
    
    // Sokak + bina numarası birleştirme
    if (binaNo && street) {
        street = `${street} No: ${binaNo}`;
    }
    
    // RANGE_INTERPOLATED ise bina no tahminidir, log bas
    if (locationType === 'RANGE_INTERPOLATED' && binaNo) {
        console.log(`⚠️ [Geocoding] Bina numarası TAHMİNİ (RANGE_INTERPOLATED): No:${binaNo} — Kullanıcı düzeltmeli.`);
    }
    
    return {
        city,
        district,
        neighborhood,
        street: street || '',
        binaNo: binaNo || '',
        formattedAddress: primaryResult.formatted_address || '',
        locationType, // ROOFTOP | RANGE_INTERPOLATED | GEOMETRIC_CENTER | APPROXIMATE
        // Ham veriyi de sakla (debug için)
        _raw: {
            placeId: primaryResult.place_id,
            types: primaryResult.types
        }
    };
}

/**
 * Forward Geocode — Adres metninden koordinatlara çevirir
 * @param {string} address - Aranacak adres metni
 * @returns {Object} { lat, lng, formattedAddress }
 */
async function forwardGeocode(address) {
    const apiKey = process.env.GOOGLE_MAPS_API_KEY;
    
    if (!apiKey) {
        throw new Error('GOOGLE_MAPS_API_KEY .env dosyasında tanımlı değil.');
    }
    
    if (!address || address.trim() === '') {
        throw new Error('Aranacak adres boş olamaz.');
    }

    const encodedAddress = encodeURIComponent(address + ' Türkiye');
    const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodedAddress}&language=tr&key=${apiKey}`;
    
    const response = await axios.get(url, { timeout: 10000 });
    
    if (response.data.status !== 'OK' || !response.data.results || response.data.results.length === 0) {
        if (response.data.status === 'ZERO_RESULTS') {
            throw new Error('Adres bulunamadı');
        }
        console.error('Google Geocoding API hatası:', response.data.status, response.data.error_message);
        
        // --- DEVELOPMENT FALLBACK FOR BILLING ERROR ---
        if (response.data.status === 'REQUEST_DENIED' && (response.data.error_message || '').includes('Billing')) {
            console.log('⚠️ [Geocoding-Fallback] Google Maps Billing hatası algılandı. Local test için Şişli/İstanbul koordinatı dönülüyor...');
            return {
                lat: 41.0682,
                lng: 29.0084,
                formattedAddress: 'Esentepe Mah, Büyükdere Cad. No:120, 34394 Şişli/İstanbul, Türkiye'
            };
        }
        
        throw new Error(`Geocoding API hatası: ${response.data.status}`);
    }
    
    const location = response.data.results[0].geometry.location;
    return {
        lat: location.lat,
        lng: location.lng,
        formattedAddress: response.data.results[0].formatted_address
    };
}

module.exports = {
    reverseGeocode,
    forwardGeocode
};
