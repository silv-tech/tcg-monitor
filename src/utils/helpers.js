function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function classifyCategory(name, categories) {
  const lower = name.toLowerCase();
  for (const [cat, keywords] of Object.entries(categories)) {
    if (keywords.some(kw => lower.includes(kw))) return cat;
  }
  return 'other';
}

function classifyProductType(name, productTypes) {
  const lower = name.toLowerCase();
  for (const [type, keywords] of Object.entries(productTypes)) {
    if (keywords.some(kw => lower.includes(kw))) return type;
  }
  return 'other';
}

function normalizePrice(priceStr) {
  if (typeof priceStr === 'number') return priceStr;
  if (!priceStr) return null;
  const cleaned = priceStr.replace(/[^0-9.]/g, '');
  const num = parseFloat(cleaned);
  return isNaN(num) ? null : num;
}

function hashSku(retailer, sku) {
  return `${retailer}:${sku}`;
}

function truncate(str, len = 256) {
  if (!str) return '';
  return str.length > len ? str.slice(0, len - 3) + '...' : str;
}

module.exports = { sleep, classifyCategory, classifyProductType, normalizePrice, hashSku, truncate };
