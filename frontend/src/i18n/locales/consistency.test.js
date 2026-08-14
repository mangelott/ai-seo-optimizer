import { describe, it, expect } from 'vitest';
import en from './en.json';
import pt from './pt.json';

const LOCALES = { en, pt };

function collectPaths(obj, prefix = '') {
  const paths = [];
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      paths.push(...collectPaths(value, path));
    } else {
      paths.push(path);
    }
  }
  return paths;
}

function getAt(obj, path) {
  return path.split('.').reduce((acc, key) => (acc == null ? acc : acc[key]), obj);
}

function interpolationTokens(str) {
  if (typeof str !== 'string') return [];
  return [...str.matchAll(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g)].map((m) => m[1]).sort();
}

describe('i18n locale consistency (en <-> pt)', () => {
  it('both locales define the exact same set of keys', () => {
    const enPaths = collectPaths(en).sort();
    const ptPaths = collectPaths(pt).sort();

    const missingInPt = enPaths.filter((p) => !ptPaths.includes(p));
    const missingInEn = ptPaths.filter((p) => !enPaths.includes(p));

    expect(missingInPt, `keys present in en.json but missing in pt.json: ${missingInPt.join(', ')}`).toEqual([]);
    expect(missingInEn, `keys present in pt.json but missing in en.json: ${missingInEn.join(', ')}`).toEqual([]);
  });

  it('no leaf string value is empty in either locale', () => {
    for (const [locale, dict] of Object.entries(LOCALES)) {
      const paths = collectPaths(dict);
      for (const path of paths) {
        const value = getAt(dict, path);
        if (typeof value === 'string') {
          expect(value.trim(), `${locale}.${path} is empty`).not.toBe('');
        }
      }
    }
  });

  it('array-valued keys have the same length in both locales', () => {
    function checkArrays(enObj, ptObj, prefix = '') {
      for (const [key, value] of Object.entries(enObj)) {
        const path = prefix ? `${prefix}.${key}` : key;
        const ptValue = ptObj?.[key];
        if (Array.isArray(value)) {
          expect(Array.isArray(ptValue), `${path} is an array in en but not in pt`).toBe(true);
          expect(ptValue.length, `${path} array length differs between en (${value.length}) and pt (${ptValue.length})`).toBe(value.length);
        } else if (value !== null && typeof value === 'object') {
          checkArrays(value, ptValue || {}, path);
        }
      }
    }
    checkArrays(en, pt);
  });

  it('interpolation placeholders ({{var}}) match between locales for every key', () => {
    const enPaths = collectPaths(en);
    const mismatches = [];
    for (const path of enPaths) {
      const enValue = getAt(en, path);
      const ptValue = getAt(pt, path);
      if (typeof enValue !== 'string' || typeof ptValue !== 'string') continue;
      const enTokens = interpolationTokens(enValue);
      const ptTokens = interpolationTokens(ptValue);
      if (JSON.stringify(enTokens) !== JSON.stringify(ptTokens)) {
        mismatches.push(`${path}: en=[${enTokens}] pt=[${ptTokens}]`);
      }
    }
    expect(mismatches, mismatches.join('\n')).toEqual([]);
  });
});
