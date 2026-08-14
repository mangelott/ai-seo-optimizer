import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import AuthLayout from '../components/layout/AuthLayout';
import Button from '../components/ui/Button';
import Input, { Label } from '../components/ui/Input';
import api from '../api/client';
import styles from './Login.module.css';

export default function ResetPassword() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token');
  const [newPassword, setNewPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await api.post('/auth/reset-password', { token, newPassword });
      navigate('/login');
    } catch (err) {
      setError(err.response?.data?.error || t('auth.registrationFailed'));
    } finally {
      setLoading(false);
    }
  }

  if (!token) {
    return (
      <AuthLayout>
        <div className={styles.card} style={{ textAlign: 'center' }}>
          <p className={styles.error}>{t('auth.invalidCredentials')}</p>
          <p className={styles.footer}>
            <Link to="/forgot-password" className={styles.footerLink}>
              {t('auth.backToLogin')}
            </Link>
          </p>
        </div>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout>
      <div className={styles.card} style={{ textAlign: 'center' }}>
        <div className={styles.mark} style={{ background: 'var(--accent-soft)', fontSize: 16 }}>
          🔑
        </div>
        <h1 className={styles.title}>
          {t('auth.forgotTitle')} <span className={styles.accent}>{t('auth.forgotTitleAccent')}</span>
        </h1>

        <form onSubmit={handleSubmit} style={{ textAlign: 'left' }}>
          <Label style={{ marginTop: 20 }}>{t('auth.password')}</Label>
          <Input
            type="password"
            placeholder={t('auth.passwordMin')}
            minLength={8}
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            required
          />
          {error && <p className={styles.error} style={{ marginTop: 12 }}>{error}</p>}
          <Button type="submit" full style={{ marginTop: 20 }} disabled={loading}>
            {loading ? t('common.loading') : t('auth.forgotCta')}
          </Button>
        </form>

        <p className={styles.footer}>
          <Link to="/login" className={styles.footerLink}>
            {t('auth.backToLogin')}
          </Link>
        </p>
      </div>
    </AuthLayout>
  );
}
