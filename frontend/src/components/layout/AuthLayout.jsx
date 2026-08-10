import { Link } from 'react-router-dom';
import ThemeToggle from '../ui/ThemeToggle';
import LanguageSwitcher from '../ui/LanguageSwitcher';
import styles from './AuthLayout.module.css';

export default function AuthLayout({ children }) {
  return (
    <div className={styles.wrap}>
      <Link to="/" className={styles.topLink}>
        <span className={styles.logoMark}>↑</span>
      </Link>
      <div className={styles.topControls}>
        <LanguageSwitcher />
        <ThemeToggle />
      </div>
      {children}
    </div>
  );
}
