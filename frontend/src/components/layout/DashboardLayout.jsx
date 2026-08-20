import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import ThemeToggle from '../ui/ThemeToggle';
import LanguageSwitcher from '../ui/LanguageSwitcher';
import api from '../../api/client';
import styles from './DashboardLayout.module.css';

const NAV_ITEMS = [
  { to: '/dashboard', icon: '🏠', key: 'dashboard' },
  { to: '/history', icon: '📈', key: 'history' },
  { to: '/settings', icon: '⚙️', key: 'settings' },
  { to: '/billing', icon: '💳', key: 'billing' },
];

// Portfolio is Agency-only (same plan === 'agency' gate as the team card in
// Settings.jsx) — only shown once the plan fetch resolves, so it never
// flashes for users on a lower plan.
const PORTFOLIO_ITEM = { to: '/portfolio', icon: '🗂️', key: 'portfolio' };

export default function DashboardLayout({ children, maxWidth }) {
  const { t } = useTranslation();
  const location = useLocation();
  const [plan, setPlan] = useState(null);

  useEffect(() => {
    api.get('/auth/me').then(({ data }) => setPlan(data.plan));
  }, []);

  const navItems = plan === 'agency' ? [...NAV_ITEMS, PORTFOLIO_ITEM] : NAV_ITEMS;

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
            {navItems.map((item) => {
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
