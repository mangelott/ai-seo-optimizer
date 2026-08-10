import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import Button from '../ui/Button';
import ThemeToggle from '../ui/ThemeToggle';
import LanguageSwitcher from '../ui/LanguageSwitcher';
import styles from './PublicHeader.module.css';

export default function PublicHeader() {
  const { t } = useTranslation();

  return (
    <div className={styles.nav}>
      <div className={styles.inner}>
        <Link to="/" className={styles.logo}>
          <span className={styles.logoMark}>↑</span>
          <span className={styles.logoText}>{t('common.appName')}</span>
        </Link>
        <div className={styles.links}>
          <span className={styles.navLinksText} style={{ display: 'flex', gap: 20 }}>
            <Link to="/pricing" className={styles.link}>{t('nav.pricing')}</Link>
            <Link to="/login" className={styles.link}>{t('nav.login')}</Link>
          </span>
          <Link to="/register">
            <Button size="sm">{t('nav.getStarted')}</Button>
          </Link>
          <div className={styles.controls}>
            <LanguageSwitcher />
            <ThemeToggle />
          </div>
        </div>
      </div>
    </div>
  );
}
