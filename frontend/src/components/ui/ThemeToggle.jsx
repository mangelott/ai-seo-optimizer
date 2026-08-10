import { useTranslation } from 'react-i18next';
import { useTheme } from '../../context/ThemeContext';
import styles from './ThemeToggle.module.css';

export default function ThemeToggle() {
  const { theme, toggleTheme } = useTheme();
  const { t } = useTranslation();

  return (
    <button type="button" className={styles.btn} onClick={toggleTheme}>
      {theme === 'light' ? `🌙 ${t('common.themeToDark')}` : `☀️ ${t('common.themeToLight')}`}
    </button>
  );
}
