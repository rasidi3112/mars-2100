// Checks every translation in src/i18n/locales against the English source (en.ts).
//
//   npm run i18n:check                 all languages
//   npm run i18n:check -- de ar        only these languages
//   npm run i18n:check -- --counters   also list CJK counter digits (see below)
//
// Exits with code 1 when any error is found, so it can run before a build or in CI.
// It proves a translation is structurally safe (nothing missing, every number, name and
// placeholder kept). It cannot judge whether a sentence is natural or correct; that needs
// a native speaker (see src/i18n/REVIEW.md).
//
// Needs Node 22.18 or newer, which can import the .ts message files directly.

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const I18N = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'i18n');
const LOCALES_DIR = join(I18N, 'locales');

const args = process.argv.slice(2);
const showCounters = args.includes('--counters');
const only = args.filter((arg) => !arg.startsWith('--'));

// Glossary rule 3: names that stay in Latin script, untranslated. "Jezero" alone, because
// "Jezero Crater" may become e.g. "cratère de Jezero".
const FIXED_NAMES = [
  'MARS 2100', 'NASA', 'JPL', 'Jezero', 'Utopia Planitia', 'Elysium Planitia', 'Perseverance', 'Curiosity',
  'InSight', 'Phoenix', 'Opportunity', 'MOXIE', 'RAD', 'SHARAD', 'MOLA', 'HiRISE', 'MRO', 'KRUSTY', 'Kilopower',
  'ISS', 'ECLSS', 'Viking 2', 'Veggie',
];
// Chinese and Japanese do not put spaces between words, so a leading/trailing space in an
// English fragment (e.g. ' + battery') is not expected there.
const NO_EDGE_SPACE = new Set(['zh-Hans', 'ja']);
// Chinese, Japanese and Korean turn English number words into digits with a counter
// ("four crew" → "4 人"). Such extra digits are reported as info, not as errors.
const COUNTER_LANGUAGES = new Set(['zh-Hans', 'ja', 'ko']);
const PLURAL_SUFFIX = /\.(zero|one|two|few|many|other)$/;

let en;
try {
  ({ en } = await import(pathToFileURL(join(LOCALES_DIR, 'en.ts')).href));
} catch (error) {
  if (error?.code === 'ERR_UNKNOWN_FILE_EXTENSION') {
    console.error(`i18n:check needs Node 22.18 or newer to read .ts files (this is Node ${process.versions.node}).`);
    process.exit(2);
  }
  throw error;
}

// The registry is the list the app really uses: which languages exist, which have a loader,
// and which locale formats their numbers.
const registry = readFileSync(join(I18N, 'registry.ts'), 'utf8');
const review = readFileSync(join(I18N, 'REVIEW.md'), 'utf8');
const numberLocales = new Map(
  [...registry.matchAll(/\{ code: '([\w-]+)',[^}]*?numberLocale: '([^']+)'/g)].map((match) => [match[1], match[2]]),
);
const loaders = new Map(
  [...registry.matchAll(/'?([\w-]+)'?: \(\) => import\('\.\/locales\/([\w-]+)'\)\.then\(\(module\) => module\.(\w+)\)/g)]
    .filter((match) => !match[1].startsWith('qps')) // dev pseudo-locales are generated from en.ts
    .map((match) => [match[1], { file: match[2], exportName: match[3] }]),
);
const files = readdirSync(LOCALES_DIR)
  .filter((file) => file.endsWith('.ts') && file !== 'en.ts' && file !== 'qps.ts')
  .map((file) => file.slice(0, -3));

const setupErrors = [];
for (const code of files) {
  if (![...loaders.values()].some((loader) => loader.file === code)) setupErrors.push(`locales/${code}.ts has no loader in registry.ts (players cannot pick it)`);
  if (!numberLocales.has(code)) setupErrors.push(`locales/${code}.ts has no entry in LOCALES (registry.ts)`);
}
for (const [code, { file }] of loaders) if (!files.includes(file)) setupErrors.push(`registry.ts loads locales/${file}.ts for '${code}', but the file is missing`);
for (const error of setupErrors) console.log(`✗ ${error}`);

const placeholders = (text) => [...new Set([...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]))].sort().join(',');

// Numbers written in a message, as values: "20.000" (id) and "20,000" (en) are both 20000.
function numbers(text, decimal) {
  const plain = text
    .replace(/\{\w+\}/g, ' ')
    .replace(/tháng \d{1,2}\b/gi, ' ') // month names written with a number ("tháng 9", "9月", "9월")
    .replace(/\d{1,2}\s?(月|월)/g, ' ');
  const values = [];
  for (const match of plain.matchAll(/\d(?:[\d.,]|[   ](?=\d{3}\b))*\d|\d/g)) {
    let value = match[0].replace(/[   ]/g, '');
    value = decimal === ','
      ? value.replace(/\.(?=\d{3}\b)/g, '').replace(',', '.')
      : value.replace(/,(?=\d{3}\b)/g, '');
    values.push(String(Number(value.replace(/[.,]$/, ''))));
  }
  return values.sort();
}

const englishKeys = Object.keys(en);
const pluralBases = englishKeys
  .filter((key) => key.endsWith('.other') && en[key.replace(/\.other$/, '.one')] !== undefined)
  .map((key) => key.slice(0, -'.other'.length));
const untranslatedProbe = new RegExp(`${FIXED_NAMES.join('|')}|\\b(sol|per)\\b|\\{\\w+\\}`, 'g');

let errorCount = setupErrors.length;
const selected = only.length ? only : [...loaders.keys()].filter((code) => files.includes(loaders.get(code).file));
for (const code of only) if (!loaders.has(code)) { console.log(`✗ unknown language '${code}'`); errorCount++; }

for (const code of selected.filter((code) => loaders.has(code))) {
  const { file, exportName } = loaders.get(code);
  if (!files.includes(file)) continue;
  const module = await import(pathToFileURL(join(LOCALES_DIR, `${file}.ts`)).href);
  const messages = module[exportName];
  const errors = [];
  const counterExtras = [];
  if (!messages) {
    console.log(`✗ ${code}: locales/${file}.ts does not export '${exportName}' (named in registry.ts)`);
    errorCount++;
    continue;
  }
  const numberLocale = numberLocales.get(code) ?? code;
  const decimal = new Intl.NumberFormat(numberLocale).formatToParts(1.5).find((part) => part.type === 'decimal').value;
  const keys = Object.keys(messages);

  for (const key of englishKeys) if (!(key in messages)) errors.push(`MISSING ${key}`);
  for (const key of keys) {
    if (key in en) continue;
    const base = key.replace(PLURAL_SUFFIX, '');
    if (base !== key && en[`${base}.other`] !== undefined) continue; // a plural form English does not need
    errors.push(`EXTRA ${key} (not in en.ts)`);
  }

  for (const key of keys) {
    const source = en[key] ?? en[key.replace(PLURAL_SUFFIX, '.other')];
    const text = messages[key];
    if (source === undefined) continue;
    if (typeof text !== 'string') { errors.push(`NOT TEXT ${key}`); continue; }
    if (source.trim() && !text.trim()) errors.push(`EMPTY ${key}`);

    // A plural form may leave out {count} (e.g. Arabic "one" says "a sol" in words).
    const plural = PLURAL_SUFFIX.test(key);
    const sourcePlaceholders = placeholders(source), textPlaceholders = placeholders(text);
    if (plural ? !textPlaceholders.split(',').every((name) => !name || sourcePlaceholders.split(',').includes(name)) : sourcePlaceholders !== textPlaceholders) {
      errors.push(`PLACEHOLDER ${key}: en {${sourcePlaceholders}} · ${code} {${textPlaceholders}}`);
    }

    if (!plural) {
      const expected = numbers(source, '.'), found = numbers(text, decimal);
      const missing = [...expected], extra = [];
      for (const value of found) { const index = missing.indexOf(value); if (index >= 0) missing.splice(index, 1); else extra.push(value); }
      if (missing.length) errors.push(`NUMBER MISSING ${key}: en [${expected.join(' ')}] · ${code} [${found.join(' ')}]`);
      else if (extra.length && COUNTER_LANGUAGES.has(code)) counterExtras.push(`${key}: +[${extra.join(' ')}]`);
      else if (extra.length) errors.push(`NUMBER ADDED ${key}: en [${expected.join(' ')}] · ${code} [${found.join(' ')}]`);
    }

    for (const name of FIXED_NAMES) if (source.includes(name) && !text.includes(name)) errors.push(`FIXED NAME ${key}: "${name}" is missing`);

    if (!NO_EDGE_SPACE.has(code)) {
      // A fragment may drop its leading space only before punctuation that attaches to the
      // previous word (", above the…").
      const lostLead = /^\s/.test(source) && !/^\s/.test(text) && !/^[,.;:!?،、。，]/.test(text);
      const lostTrail = /\s$/.test(source) && !/\s$/.test(text);
      const addedLead = !/^\s/.test(source) && /^\s/.test(text);
      if (lostLead || lostTrail || addedLead) errors.push(`EDGE SPACE ${key}: en ${JSON.stringify(source)} · ${code} ${JSON.stringify(text)}`);
    }

    // Same text as English with at least two real English words left: most likely forgotten.
    if (text === source && (source.replace(untranslatedProbe, '').match(/[a-z]{3,}/gi)?.length ?? 0) >= 2) {
      errors.push(`UNTRANSLATED ${key}: ${JSON.stringify(source.slice(0, 60))}`);
    }
  }

  // Every plural form the language uses (for counts 0–1000) must exist.
  const rules = new Intl.PluralRules(numberLocale);
  const categories = [...new Set(Array.from({ length: 1001 }, (_, count) => rules.select(count)))];
  for (const base of pluralBases) for (const category of categories) {
    if (messages[`${base}.${category}`] === undefined) errors.push(`PLURAL ${base}.${category} missing (${code} needs: ${categories.join(', ')})`);
  }

  // Glossary rule 4: OBSERVED / MODELLED / GAMEPLAY tags must not share a letter.
  const letters = ['OBSERVED', 'MODELLED', 'GAMEPLAY'].map((tag) => messages[`common.evidenceLetter.${tag}`]);
  if (new Set(letters).size !== letters.length) errors.push(`EVIDENCE LETTERS not distinct: ${letters.join(' / ')}`);

  const reviewNote = review.includes(`\`${file}.ts\``) ? '' : ' · not listed in REVIEW.md';
  console.log(`${errors.length ? '✗' : '✓'} ${code}: ${keys.length} keys (en ${englishKeys.length}) · plural forms [${categories.join(', ')}] · ${errors.length} error(s)${reviewNote}`);
  for (const error of errors) console.log(`    ${error}`);
  if (counterExtras.length) {
    console.log(`    (info) ${counterExtras.length} message(s) add counter digits${showCounters ? ':' : ' — list them with --counters'}`);
    if (showCounters) for (const line of counterExtras) console.log(`      ${line}`);
  }
  errorCount += errors.length;
}

console.log(errorCount ? `\ni18n:check found ${errorCount} error(s).` : '\ni18n:check passed. Native-speaker review is still needed: see src/i18n/REVIEW.md.');
process.exit(errorCount ? 1 : 0);
