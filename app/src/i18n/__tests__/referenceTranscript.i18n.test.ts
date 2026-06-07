import { describe, expect, it } from 'vitest';
import en from '@/i18n/locales/en/translation.json';
import ja from '@/i18n/locales/ja/translation.json';
import zhCN from '@/i18n/locales/zh-CN/translation.json';
import zhTW from '@/i18n/locales/zh-TW/translation.json';

const REQUIRED = [
  'label',
  'transcribing',
  'downloadingModel',
  'autoFilledHint',
  'errorNote',
  'retranscribe',
  'regeneratePrompt',
  'regenerate',
  'keepEdits',
] as const;

const locales = { en, ja, 'zh-CN': zhCN, 'zh-TW': zhTW } as Record<
  string,
  { referenceTranscript?: Record<string, string> }
>;

describe('referenceTranscript i18n parity', () => {
  for (const [name, dict] of Object.entries(locales)) {
    it(`${name} has all referenceTranscript keys`, () => {
      const block = dict.referenceTranscript;
      expect(block, `${name} missing referenceTranscript block`).toBeDefined();
      for (const key of REQUIRED) {
        expect(block?.[key], `${name} missing referenceTranscript.${key}`).toBeTruthy();
      }
    });
  }
});
