import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import DashboardLayout from '../components/layout/DashboardLayout';
import Button from '../components/ui/Button';
import Input, { Label } from '../components/ui/Input';
import api from '../api/client';
import styles from './Settings.module.css';

export default function Settings() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [profileMsg, setProfileMsg] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [passwordMsg, setPasswordMsg] = useState('');
  const [passwordError, setPasswordError] = useState('');
  const [domains, setDomains] = useState([]);

  useEffect(() => {
    api.get('/auth/me').then(({ data }) => {
      setName(data.name || '');
      setEmail(data.email || '');
    });
    api.get('/domains').then(({ data }) => setDomains(data));
  }, []);

  const initials = (name || email || '?').slice(0, 2).toUpperCase();

  async function saveProfile(e) {
    e.preventDefault();
    setProfileMsg('');
    await api.patch('/auth/me', { name, email });
    setProfileMsg(t('common.save') + ' ✓');
    setTimeout(() => setProfileMsg(''), 2000);
  }

  async function updatePassword(e) {
    e.preventDefault();
    setPasswordMsg('');
    setPasswordError('');
    try {
      await api.post('/auth/change-password', { currentPassword, newPassword });
      setPasswordMsg(t('common.save') + ' ✓');
      setCurrentPassword('');
      setNewPassword('');
    } catch (err) {
      setPasswordError(err.response?.data?.error || 'Error');
    }
  }

  async function removeDomain(id) {
    await api.delete(`/domains/${id}`);
    setDomains((d) => d.filter((x) => x.id !== id));
  }

  async function deleteAccount() {
    if (!window.confirm(t('settings.deleteAccount') + '?')) return;
    await api.delete('/auth/me');
    localStorage.removeItem('token');
    navigate('/');
  }

  return (
    <DashboardLayout maxWidth={760}>
      <h1 className={styles.title}>{t('settings.title')}</h1>

      <div className={styles.card}>
        <h3 style={{ fontSize: 18, fontWeight: 600, margin: 0, color: 'var(--text)' }}>{t('settings.profile')}</h3>
        <div className={styles.avatarRow}>
          <div className={styles.avatar}>{initials}</div>
          <Button variant="secondary" size="sm" type="button">
            {t('settings.changePhoto')}
          </Button>
        </div>
        <form onSubmit={saveProfile}>
          <div className={styles.grid2}>
            <div>
              <Label>{t('settings.name')}</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div>
              <Label>{t('settings.email')}</Label>
              <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
            </div>
          </div>
          <Button type="submit" size="sm" style={{ marginTop: 20 }}>
            {t('settings.saveChanges')}
          </Button>
          {profileMsg && <p className={styles.success}>{profileMsg}</p>}
        </form>
      </div>

      <div className={styles.card}>
        <h3 style={{ fontSize: 18, fontWeight: 600, margin: 0, color: 'var(--text)' }}>{t('settings.password')}</h3>
        <form onSubmit={updatePassword}>
          <div className={styles.grid2}>
            <div>
              <Label>{t('settings.currentPassword')}</Label>
              <Input type="password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} />
            </div>
            <div>
              <Label>{t('settings.newPassword')}</Label>
              <Input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} minLength={8} />
            </div>
          </div>
          <Button variant="secondary" size="sm" type="submit" style={{ marginTop: 20 }}>
            {t('settings.updatePassword')}
          </Button>
          {passwordMsg && <p className={styles.success}>{passwordMsg}</p>}
          {passwordError && <p className={styles.error}>{passwordError}</p>}
        </form>
      </div>

      <div className={styles.card}>
        <h3 style={{ fontSize: 18, fontWeight: 600, margin: 0, color: 'var(--text)' }}>{t('settings.monitoredDomains')}</h3>
        <div className={styles.domainsList}>
          {domains.map((d) => (
            <div className={styles.domainRow} key={d.id}>
              <span style={{ fontSize: 14, color: 'var(--text)' }}>{d.domain.replace(/^https?:\/\//, '')}</span>
              <button className={styles.removeBtn} onClick={() => removeDomain(d.id)}>
                {t('settings.remove')}
              </button>
            </div>
          ))}
        </div>
      </div>

      <div className={styles.dangerCard}>
        <h3 className={styles.dangerTitle}>{t('settings.dangerZone')}</h3>
        <p className={styles.dangerText}>{t('settings.dangerZoneDesc')}</p>
        <Button variant="danger" size="sm" style={{ marginTop: 12 }} onClick={deleteAccount}>
          {t('settings.deleteAccount')}
        </Button>
      </div>
    </DashboardLayout>
  );
}
