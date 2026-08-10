import { Link, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import ThemeToggle from '../ui/ThemeToggle';
import LanguageSwitcher from '../ui/LanguageSwitcher';
import styles from './DashboardLayout.module.css';

const NAV_ITEMS = [
  { to: '/dashboard', icon: '🏠', key: 'dashboard' },
  { to: '/history', icon: '📈', key: 'history' },
  { to: '/settings', icon: '⚙️', key: 'settings' },
  { to: '/billing', icon: '💳', key: 'billing' },
];

export default function DashboardLayout({ children, maxWidth }) {
  const { t } = useTranslation();
  const location = useLocation();

  return (
    <div className={styles.shell}>
      <div style={{ display: 'flex', flexDirection: 'column', width: '100%' }}>
        <div className={styles.topbar}>
          <Link to="/" className={styles.logo}>
            <span className={styles.logoMark}>↑</span>
            <span className={styles.logoText}>{t('common.appName')}</span>
          </Link>
          <div className={styles.controls}>
            <LanguageSwitcher />
            <ThemeToggle />
          </div>
        </div>
        <div className={styles.body}>
          <div className={styles.sidebar}>
            {NAV_ITEMS.map((item) => {
              const active =
                location.pathname === item.to ||
                (item.to === '/dashboard' && location.pathname.startsWith('/audits/'));
              return (
                <Link
                  key={item.to}
                  to={item.to}
                  className={`${styles.navItem} ${active ? styles.navItemActive : ''}`}
                >
                  <span>{item.icon}</span>
                  <span>{t(`nav.${item.key}`)}</span>
                </Link>
              );
            })}
          </div>
          <div className={styles.content} style={maxWidth ? { maxWidth } : undefined}>
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}
