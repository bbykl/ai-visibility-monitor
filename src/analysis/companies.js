export const normalizeName = value => String(value || '').toLowerCase().replace(/[\s·•（）()]/g, '');

// Accept the old object format during migration; persist only distinct names.
export function companyNames(items = []) {
  const seen = new Set();
  return items.flatMap(item => {
    const name = String(typeof item === 'string' ? item : item?.name || '').trim();
    const key = normalizeName(name);
    if (!key || name.length > 100 || seen.has(key)) return [];
    seen.add(key); return [name];
  });
}

export function validateCompanies(raw, text) {
  return companyNames(raw).filter(name => text.includes(name)).sort((a, b) => text.indexOf(a) - text.indexOf(b));
}

export function matchesCompany(companies, name, aliases = []) {
  const keys = new Set([name, ...aliases].map(normalizeName).filter(Boolean));
  return companyNames(companies).some(company => keys.has(normalizeName(company)));
}
