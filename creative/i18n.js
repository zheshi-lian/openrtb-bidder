// creative/i18n.js —— 多语言本地化：文案变体管理 + 复数规则 + RTL + 自动翻译钩子
//
// 出海投放里，"同一套素材翻成 12 种语言"是纯人力活，也是创意自动化的高频刚需。
// 这里提供：locale 注册表（含 RTL 标记）、按 locale 取文案、CLDR 复数规则、
// 数字/货币格式化、以及对接 LLM 的自动翻译钩子（translator 由调用方注入，如 llm.js）。

const LOCALES = {
  'en-US': { name: 'English (US)', rtl: false, plural: 'en', currency: 'USD' },
  'zh-CN': { name: '简体中文', rtl: false, plural: 'zh', currency: 'CNY' },
  'zh-TW': { name: '繁體中文', rtl: false, plural: 'zh', currency: 'TWD' },
  'ja-JP': { name: '日本語', rtl: false, plural: 'zh', currency: 'JPY' },
  'ko-KR': { name: '한국어', rtl: false, plural: 'zh', currency: 'KRW' },
  'es-ES': { name: 'Español', rtl: false, plural: 'en', currency: 'EUR' },
  'pt-BR': { name: 'Português (BR)', rtl: false, plural: 'en', currency: 'BRL' },
  'de-DE': { name: 'Deutsch', rtl: false, plural: 'en', currency: 'EUR' },
  'fr-FR': { name: 'Français', rtl: false, plural: 'fr', currency: 'EUR' },
  'ru-RU': { name: 'Русский', rtl: false, plural: 'ru', currency: 'RUB' },
  'tr-TR': { name: 'Türkçe', rtl: false, plural: 'en', currency: 'TRY' },
  'ar-SA': { name: 'العربية', rtl: true, plural: 'ar', currency: 'SAR' },
  'hi-IN': { name: 'हिन्दी', rtl: false, plural: 'en', currency: 'INR' },
  'th-TH': { name: 'ไทย', rtl: false, plural: 'zh', currency: 'THB' },
  'vi-VN': { name: 'Tiếng Việt', rtl: false, plural: 'zh', currency: 'VND' },
  'id-ID': { name: 'Bahasa Indonesia', rtl: false, plural: 'zh', currency: 'IDR' },
};

let pool = null;
function attachPool(p) { pool = p; }
async function initTables() {
  if (!pool) return;
  await pool.query(`CREATE TABLE IF NOT EXISTS creative_i18n (
    id BIGINT AUTO_INCREMENT PRIMARY KEY, creative_id INT DEFAULT 0, campaign_id INT DEFAULT 0,
    locale VARCHAR(8), field VARCHAR(24), text TEXT, source VARCHAR(16) DEFAULT 'human',
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uk_i18n (creative_id, campaign_id, locale, field))`).catch(() => {});
}

function isRtl(locale) { return !!(LOCALES[normalize(locale)] || {}).rtl; }
function normalize(locale) {
  const s = String(locale || '').replace('_', '-');
  if (LOCALES[s]) return s;
  const lang = s.split('-')[0].toLowerCase();
  const hit = Object.keys(LOCALES).find(k => k.split('-')[0].toLowerCase() === lang);
  return hit || 'en-US';
}
// CLDR 复数类别（简化版，覆盖主要出海语种）
function pluralCategory(locale, n) {
  const rule = (LOCALES[normalize(locale)] || {}).plural || 'en';
  const i = Math.floor(Math.abs(Number(n) || 0));
  switch (rule) {
    case 'zh': return 'other';                                   // 中日韩泰越印尼无复数
    case 'fr': return i < 2 ? 'one' : 'other';                   // 法语 0/1 视为单数
    case 'ru': {
      const m10 = i % 10, m100 = i % 100;
      if (m10 === 1 && m100 !== 11) return 'one';
      if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return 'few';
      return 'many';
    }
    case 'ar': {
      const m100 = i % 100;
      if (i === 0) return 'zero';
      if (i === 1) return 'one';
      if (i === 2) return 'two';
      if (m100 >= 3 && m100 <= 10) return 'few';
      if (m100 >= 11 && m100 <= 99) return 'many';
      return 'other';
    }
    default: return i === 1 ? 'one' : 'other';
  }
}
// forms: {one:'1 件商品', other:'{{n}} 件商品'}
function plural(locale, n, forms = {}) {
  const cat = pluralCategory(locale, n);
  const t = forms[cat] != null ? forms[cat] : (forms.other || forms.one || '');
  return String(t).replace(/\{\{n\}\}/g, String(n));
}
function formatMoney(locale, micros, opts = {}) {
  const loc = normalize(locale);
  const cur = opts.currency || LOCALES[loc].currency || 'USD';
  const v = Number(micros || 0) / 1e6;
  const frac = ['JPY', 'KRW', 'VND', 'IDR'].includes(cur) ? 0 : 2;
  try {
    return new Intl.NumberFormat(loc, { style: 'currency', currency: cur, minimumFractionDigits: frac, maximumFractionDigits: frac }).format(v);
  } catch (e) { return cur + ' ' + v.toFixed(frac); }
}

// ───────── 文案存取 ─────────
async function setText(scope, locale, field, text, source = 'human') {
  const loc = normalize(locale);
  if (pool) {
    await pool.query(
      `INSERT INTO creative_i18n (creative_id,campaign_id,locale,field,text,source) VALUES (?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE text=VALUES(text), source=VALUES(source)`,
      [Number(scope.creativeId) || 0, Number(scope.campaignId) || 0, loc, String(field).slice(0, 24), String(text), source]);
  }
  return { ok: true, locale: loc, field, text };
}
async function getText(scope, locale, field) {
  const loc = normalize(locale);
  if (!pool) return '';
  const [[r]] = await pool.query(
    'SELECT text FROM creative_i18n WHERE creative_id=? AND campaign_id=? AND locale=? AND field=?',
    [Number(scope.creativeId) || 0, Number(scope.campaignId) || 0, loc, String(field).slice(0, 24)]);
  return r ? r.text : '';
}
async function allTexts(scope) {
  if (!pool) return {};
  const [rows] = await pool.query(
    'SELECT locale,field,text FROM creative_i18n WHERE creative_id=? AND campaign_id=?',
    [Number(scope.creativeId) || 0, Number(scope.campaignId) || 0]);
  const out = {};
  rows.forEach(r => { (out[r.locale] = out[r.locale] || {})[r.field] = r.text; });
  return out;
}

// 本地化一条创意：逐字段取译文，缺失则回退（先 locale→语言→默认）
function localize(copy = {}, locale, fallback = 'en-US') {
  const loc = normalize(locale);
  const fb = normalize(fallback);
  const out = {};
  for (const k in copy) {
    const v = copy[k];
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      out[k] = v[loc] != null ? v[loc] : (v[fb] != null ? v[fb] : (v['en-US'] != null ? v['en-US'] : ''));
    } else out[k] = v;
  }
  out._locale = loc; out._rtl = isRtl(loc);
  return out;
}

// 自动翻译：translator(text, from, to) 由调用方注入（可接 llm.js / 第三方翻译 API）
async function autoTranslate(copy, targets, translator, from = 'en-US') {
  if (typeof translator !== 'function') return { ok: false, reason: 'NO_TRANSLATOR' };
  const out = {};
  for (const t of targets) {
    const loc = normalize(t);
    if (loc === normalize(from)) continue;
    out[loc] = {};
    for (const k in copy) {
      try { out[loc][k] = await translator(String(copy[k]), normalize(from), loc); }
      catch (e) { out[loc][k] = ''; }
    }
  }
  return { ok: true, translated: out };
}
// 批量落地：把翻译结果写入 creative_i18n
async function persistTranslations(scope, translated, source = 'machine') {
  let n = 0;
  for (const loc in translated) {
    for (const field in translated[loc]) {
      await setText(scope, loc, field, translated[loc][field], source); n++;
    }
  }
  return { ok: true, written: n };
}

module.exports = {
  LOCALES, attachPool, initTables,
  normalize, isRtl, pluralCategory, plural, formatMoney,
  setText, getText, allTexts, localize, autoTranslate, persistTranslations,
};
