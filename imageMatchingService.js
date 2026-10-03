const fs = require("fs");
const path = require("path");

// ─────────────────────────────────────────────
// Konfigürasyon
// ─────────────────────────────────────────────
const getGlobalImagesDir = () => {
  const possiblePaths = [
    path.join(__dirname, "../uploads/global/products"),
    path.join(__dirname, "../../Globalurunresimleri"),
    path.join(process.cwd(), "uploads/global/products"),
    path.join(process.cwd(), "../Globalurunresimleri")
  ];

  for (const p of possiblePaths) {
    if (fs.existsSync(p)) return p;
  }
  return possiblePaths[0]; // Fallback to default
};

const GLOBAL_IMAGES_DIR = getGlobalImagesDir();
console.log(`🔍 [ImageMatching] Global resim dizini: ${GLOBAL_IMAGES_DIR}`);
const GLOBAL_IMAGES_URL_PREFIX = GLOBAL_IMAGES_DIR.includes("Globalurunresimleri") 
  ? "/Globalurunresimleri" 
  : "/uploads/global/products";

const MATCH_THRESHOLD = 0.70; // Minimum benzerlik skoru (0-1 arası)
const DEFAULT_IMAGE = "/uploads/defaults/burger.jpg";

// ─────────────────────────────────────────────
// Türkçe karakter haritası
// ─────────────────────────────────────────────
const TR_CHAR_MAP = {
  'ç': 'c', 'Ç': 'c',
  'ğ': 'g', 'Ğ': 'g',
  'ı': 'i', 'İ': 'i',
  'ö': 'o', 'Ö': 'o',
  'ş': 's', 'Ş': 's',
  'ü': 'u', 'Ü': 'u',
  'â': 'a', 'Â': 'a',
  'î': 'i', 'Î': 'i',
  'û': 'u', 'Û': 'u',
};

// ─────────────────────────────────────────────
// Yardımcı Fonksiyonlar
// ─────────────────────────────────────────────

/**
 * Türkçe karakterleri ASCII eşdeğerlerine çevirir
 */
const removeTurkishChars = (str) => {
  return str.replace(/[çÇğĞıİöÖşŞüÜâÂîÎûÛ]/g, (char) => TR_CHAR_MAP[char] || char);
};

/**
 * Bir ürün adını slug'a çevirir (normalize eder)
 * "Kaşarlı Et Döner Dürüm" → "kasarli-et-doner-durum"
 */
const toSlug = (text) => {
  return removeTurkishChars(text)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')  // alfanümerik ve boşluk dışını sil
    .replace(/\s+/g, '-')           // boşlukları tire yap
    .replace(/-+/g, '-')            // çoklu tireleri teke indir
    .replace(/^-|-$/g, '');         // baş ve sondaki tireleri sil
};

/**
 * Slug'ı kelime listesine çevirir
 * "kasarli-et-doner-durum" → ["kasarli", "et", "doner", "durum"]
 */
const slugToWords = (slug) => {
  return slug.split('-').filter(w => w.length > 0);
};

/**
 * Bigram setini oluşturur (Dice Coefficient için)
 * "kasarli" → {"ka", "as", "sa", "ar", "rl", "li"}
 */
const getBigrams = (str) => {
  const bigrams = new Set();
  for (let i = 0; i < str.length - 1; i++) {
    bigrams.add(str.substring(i, i + 2));
  }
  return bigrams;
};

/**
 * Dice Coefficient: iki string arasındaki benzerlik skoru (0-1)
 * Kelime sırası farklı olsa da iyi çalışır
 */
const diceCoefficient = (str1, str2) => {
  if (str1 === str2) return 1.0;
  if (str1.length < 2 || str2.length < 2) return 0.0;

  const bigrams1 = getBigrams(str1);
  const bigrams2 = getBigrams(str2);

  let intersection = 0;
  for (const bigram of bigrams1) {
    if (bigrams2.has(bigram)) {
      intersection++;
    }
  }

  return (2.0 * intersection) / (bigrams1.size + bigrams2.size);
};

/**
 * Kelime bazlı benzerlik skoru
 * Ortak kelime oranını hesaplar (düzen farketmez)
 */
const wordOverlapScore = (words1, words2) => {
  if (words1.length === 0 || words2.length === 0) return 0;
  
  let matchCount = 0;
  const used = new Set();
  
  for (const w1 of words1) {
    let bestScore = 0;
    let bestIdx = -1;
    
    for (let i = 0; i < words2.length; i++) {
      if (used.has(i)) continue;
      const score = diceCoefficient(w1, words2[i]);
      if (score > bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }
    
    if (bestScore >= 0.7 && bestIdx >= 0) {
      matchCount++;
      used.add(bestIdx);
    }
  }
  
  // İki tarafın da kapsanmasını değerlendir
  const coverage = (2 * matchCount) / (words1.length + words2.length);
  return coverage;
};

/**
 * Hibrit skor: Dice Coefficient + Kelime overlap ortalaması
 */
const combinedScore = (productSlug, imageSlug) => {
  const dice = diceCoefficient(productSlug, imageSlug);
  
  const words1 = slugToWords(productSlug);
  const words2 = slugToWords(imageSlug);
  const wordScore = wordOverlapScore(words1, words2);
  
  // Ağırlıklı ortalama: kelime eşleşmesine biraz daha fazla ağırlık
  return (dice * 0.4) + (wordScore * 0.6);
};

// ─────────────────────────────────────────────
// Global Image Index (Lazy Load)
// ─────────────────────────────────────────────

let _imageIndex = null;

/**
 * Bir dizini ve alt dizinlerini rekürsif olarak tarar, resimleri bulur.
 */
const scanDirectory = (dir, urlPrefix, results = []) => {
  try {
    if (!fs.existsSync(dir)) return results;

    const files = fs.readdirSync(dir);
    for (const file of files) {
      const fullPath = path.join(dir, file);
      const stat = fs.statSync(fullPath);

      if (stat.isDirectory()) {
        // Alt dizine gir (node_modules ve .git gibi yerleri tarama)
        if (file !== 'node_modules' && file !== '.git') {
          scanDirectory(fullPath, `${urlPrefix}/${file}`, results);
        }
      } else {
        const ext = path.extname(file).toLowerCase();
        if (['.png', '.jpg', '.jpeg', '.webp'].includes(ext)) {
          const slug = path.basename(file, ext);
          const words = slugToWords(slug);
          // URL'i oluştururken çift slash'ları engelle
          const url = `${urlPrefix}/${file}`.replace(/\/+/g, '/');
          
          results.push({ slug, words, url, file });
        }
      }
    }
  } catch (err) {
    console.error(`Error scanning directory ${dir}:`, err.message);
  }
  return results;
};

/**
 * Tüm olası resim dizinlerini tarar ve merkezi bir index oluşturur.
 */
const getImageIndex = () => {
  if (_imageIndex) return _imageIndex;

  _imageIndex = [];

  // Tarama yapılacak ana yerler (sadece ürün görselleri)
  const scanSources = [
    { 
      path: path.join(__dirname, "../uploads/global/products"), 
      url: "/uploads/global/products" 
    },
    { 
      path: path.join(__dirname, "../../Globalurunresimleri"), 
      url: "/Globalurunresimleri" 
    }
  ];

  for (const source of scanSources) {
    if (fs.existsSync(source.path)) {
      console.log(`🔍 [ImageMatching] Taranıyor: ${source.path}`);
      scanDirectory(source.path, source.url, _imageIndex);
    }
  }

  // Tekrarlanan URL'leri temizle (opsiyonel)
  const uniqueUrls = new Set();
  _imageIndex = _imageIndex.filter(item => {
    if (uniqueUrls.has(item.url)) return false;
    uniqueUrls.add(item.url);
    return true;
  });

  console.log(`✅ [ImageMatching] Toplam ${_imageIndex.length} resim tarandı ve indekslendi.`);
  return _imageIndex;
};

/**
 * Önbelleği temizler (yeni resimler eklendiğinde kullanılır)
 */
const clearCache = () => {
  _imageIndex = null;
  console.log(`🔄 [ImageMatching] Önbellek temizlendi.`);
};

// ─────────────────────────────────────────────
// Ana Eşleştirme Fonksiyonu
// ─────────────────────────────────────────────

/**
 * Bir ürün adı için en iyi eşleşen global resmi bulur.
 * 
 * @param {string} productName - Ürün adı (ör. "Kaşarlı Et Döner Dürüm")
 * @returns {{ url: string, score: number, matched: string } | null} - Eşleşme sonucu veya null
 */
const findBestMatch = (productName) => {
  if (!productName || typeof productName !== 'string') return null;

  const index = getImageIndex();
  // YAPAY ZEKA SADECE YEMEK KLASÖRÜNÜ BAZ ALSIN (Market ürünlerini dışla)
  const aiIndex = index.filter(img => !img.url.includes('/market/'));
  
  if (aiIndex.length === 0) return null;

  const productSlug = toSlug(productName);
  if (!productSlug) return null;

  // ─── Aşama 1: Exact Slug Match ───
  const exactMatch = aiIndex.find(img => img.slug === productSlug);
  if (exactMatch) {
    console.log(`🎯 [ImageMatching] EXACT: "${productName}" → ${exactMatch.file}`);
    return { url: exactMatch.url, score: 1.0, matched: exactMatch.slug };
  }

  // ─── Aşama 2: Fuzzy Match (Hibrit Skor) ───
  let bestScore = 0;
  let bestMatch = null;

  for (const img of aiIndex) {
    const score = combinedScore(productSlug, img.slug);
    if (score > bestScore) {
      bestScore = score;
      bestMatch = img;
    }
  }

  if (bestMatch && bestScore >= MATCH_THRESHOLD) {
    console.log(`🔍 [ImageMatching] FUZZY: "${productName}" → ${bestMatch.file} (skor: ${bestScore.toFixed(3)})`);
    return { url: bestMatch.url, score: bestScore, matched: bestMatch.slug };
  }

  console.log(`⬜ [ImageMatching] NO MATCH: "${productName}" (en iyi skor: ${bestScore.toFixed(3)}${bestMatch ? ', aday: ' + bestMatch.slug : ''})`);
  return null;
};

/**
 * Bir ürün adı için resim URL'ini döndürür.
 * Eşleşme yoksa DEFAULT_IMAGE döner.
 * 
 * @param {string} productName - Ürün adı
 * @returns {string} - Resim URL'i
 */
const getImageUrl = (productName) => {
  const match = findBestMatch(productName);
  return match ? match.url : DEFAULT_IMAGE;
};

/**
 * Birden fazla ürünü toplu eşleştirir (debug/test için).
 * 
 * @param {string[]} productNames - Ürün adları listesi
 * @returns {Array<{ name: string, image: string, score: number, matched: string|null }>}
 */
const batchMatch = (productNames) => {
  return productNames.map(name => {
    const match = findBestMatch(name);
    return {
      name,
      image: match ? match.url : DEFAULT_IMAGE,
      score: match ? match.score : 0,
      matched: match ? match.matched : null
    };
  });
};

/**
 * Görselleri arar ve sayfalanmış sonuç döner.
 * Frontend'in 12.500 görseli tek seferde çekmesini engeller.
 * 
 * @param {string} search - Arama terimi (ör. "kola", "lahmacun pide")
 * @param {number} page - Sayfa numarası (1'den başlar)
 * @param {number} limit - Sayfa başına sonuç (varsayılan 50)
 * @returns {{ data: Array, total: number, page: number, totalPages: number }}
 */
const searchImages = (search = "", page = 1, limit = 50) => {
  const index = getImageIndex();
  
  let filtered = index;

  if (search && search.trim()) {
    const searchNormalized = removeTurkishChars(search.toLowerCase().trim());
    const searchWords = searchNormalized.split(/[\s-]+/).filter(w => w);

    filtered = index.filter(img => {
      if (searchWords.length === 0) return true;
      const imgSlug = removeTurkishChars(img.slug.toLowerCase());
      const imgWordsStr = img.words ? img.words.map(w => removeTurkishChars(w.toLowerCase())).join(" ") : "";
      const targetText = imgSlug + " " + imgWordsStr;

      return searchWords.every(word => {
        // Kelime sınırı araması: "kola" → "çikolata" eşleşmesin
        return targetText.includes(` ${word}`) ||
               targetText.startsWith(word) ||
               targetText.includes(`-${word}`);
      });
    });
  }

  // Yemek öncelikli sıralama
  filtered.sort((a, b) => {
    const aIsYemek = a.url.includes('/yemek/');
    const bIsYemek = b.url.includes('/yemek/');
    if (aIsYemek && !bIsYemek) return -1;
    if (!aIsYemek && bIsYemek) return 1;
    return a.slug.localeCompare(b.slug, 'tr');
  });

  const total = filtered.length;
  const totalPages = Math.ceil(total / limit);
  const safePage = Math.max(1, Math.min(page, totalPages || 1));
  const startIdx = (safePage - 1) * limit;
  const data = filtered.slice(startIdx, startIdx + limit);

  return { data, total, page: safePage, totalPages };
};

module.exports = {
  findBestMatch,
  getImageUrl,
  getImageIndex,
  searchImages,
  batchMatch,
  clearCache,
  toSlug,
  diceCoefficient,
  DEFAULT_IMAGE,
  MATCH_THRESHOLD
};
