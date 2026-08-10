import { useTranslation } from 'react-i18next';
import { SUPPORTED_LANGUAGES } from '../../i18n';
import styles from './ThemeToggle.module.css';

const LABELS = { en: 'EN', pt: 'PT' };

export default function LanguageSwitcher() {
  const { i18n } = useTranslation();
  const current = SUPPORTED_LANGUAGES.includes(i18n.resolvedLanguage) ? i18n.resolvedLanguage : 'en';

  function cycle() {
    const idx = SUPPORTED_LANGUAGES.indexOf(current);
    const next = SUPPORTED_LANGUAGES[(idx + 1) % SUPPORTED_LANGUAGES.length];
    i18n.changeLanguage(next);
  }

  return (
    <button type="button" className={styles.btn} onClick={cycle} title="Language">
      🌐 {LABELS[current] || current.toUpperCase()}
    </button>
  );
}
