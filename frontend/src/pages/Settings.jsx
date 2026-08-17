import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import DashboardLayout from '../components/layout/DashboardLayout';
import Button from '../components/ui/Button';
import Input, { Label } from '../components/ui/Input';
import Switch from '../components/ui/Switch';
import api, { API_BASE_URL } from '../api/client';
import styles from './Settings.module.css';

const DEFAULT_INTERVAL_DAYS = 7;
const DEFAULT_DELIVERY = 'in_app';

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
  const [gscConnected, setGscConnected] = useState(false);
  const [gscSites, setGscSites] = useState([]);
  const [gscNotice, setGscNotice] = useState('');

  useEffect(() => {
    api.get('/auth/me').then(({ data }) => {
      setName(data.name || '');
      setEmail(data.email || '');
    });
    api.get('/domains').then(({ data }) => setDomains(data));
    api.get('/gsc/status').then(({ data }) => setGscConnected(data.connected));

    const params = new URLSearchParams(window.location.search);
    const gscParam = params.get('gsc');
    if (gscParam === 'connected') setGscNotice('success');
    else if (gscParam === 'error') setGscNotice('error');
    if (gscParam) {
      params.delete('gsc');
      const newSearch = params.toString();
      window.history.replaceState({}, '', window.location.pathname + (newSearch ? `?${newSearch}` : ''));
    }
  }, []);

  useEffect(() => {
    if (!gscConnected) return;
    api
      .get('/gsc/sites')
      .then(({ data }) => setGscSites(data))
      .catch(() => setGscSites([]));
  }, [gscConnected]);

  function connectGsc() {
    const token = localStorage.getItem('token');
    window.location.href = `${API_BASE_URL}/gsc/connect?token=${encodeURIComponent(token)}`;
  }

  async function disconnectGsc() {
    await api.delete('/gsc/disconnect');
    setGscConnected(false);
    setGscSites([]);
    setDomains((d) => d.map((x) => ({ ...x, gsc_site_url: null })));
  }

  async function linkGscSite(domainId, siteUrl) {
    const { data } = await api.patch(`/gsc/domains/${domainId}`, { siteUrl: siteUrl || null });
    setDomains((d) => d.map((x) => (x.id === domainId ? { ...x, ...data } : x)));
  }

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

  async function updateRecurring(id, patch) {
    const { data } = await api.patch(`/domains/${id}`, patch);
    setDomains((d) => d.map((x) => (x.id === id ? { ...x, ...data } : x)));
  }

  function toggleRecurring(domain, enabled) {
    updateRecurring(domain.id, {
      recurringEnabled: enabled,
      recurringIntervalDays: domain.recurring_interval_days || DEFAULT_INTERVAL_DAYS,
      recurringDelivery: domain.recurring_delivery || DEFAULT_DELIVERY,
    });
  }

  function changeRecurringInterval(domain, days) {
    if (!Number.isInteger(days) || days <= 0) return;
    updateRecurring(domain.id, {
      recurringEnabled: true,
      recurringIntervalDays: days,
      recurringDelivery: domain.recurring_delivery || DEFAULT_DELIVERY,
    });
  }

  function changeRecurringDelivery(domain, delivery) {
    updateRecurring(domain.id, {
      recurringEnabled: true,
      recurringIntervalDays: domain.recurring_interval_days || DEFAULT_INTERVAL_DAYS,
      recurringDelivery: delivery,
    });
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
        <h3 style={{ fontSize: 18, fontWeight: 600, margin: 0, color: 'var(--text)' }}>{t('settings.gsc')}</h3>
        <p className={styles.dangerText} style={{ marginTop: 4 }}>{t('settings.gscDesc')}</p>
        {gscNotice === 'success' && <p className={styles.success}>{t('settings.gscConnectedNotice')}</p>}
        {gscNotice === 'error' && <p className={styles.error}>{t('settings.gscErrorNotice')}</p>}
        <div style={{ marginTop: 16 }}>
          {gscConnected ? (
            <Button variant="secondary" size="sm" type="button" onClick={disconnectGsc}>
              {t('settings.gscDisconnect')}
            </Button>
          ) : (
            <Button size="sm" type="button" onClick={connectGsc}>
              {t('settings.gscConnect')}
            </Button>
          )}
        </div>
      </div>

      <div className={styles.card}>
        <h3 style={{ fontSize: 18, fontWeight: 600, margin: 0, color: 'var(--text)' }}>{t('settings.monitoredDomains')}</h3>
        <div className={styles.domainsList}>
          {domains.map((d) => (
            <div className={styles.domainCard} key={d.id}>
              <div className={styles.domainRow}>
                <span style={{ fontSize: 14, color: 'var(--text)' }}>{d.domain.replace(/^https?:\/\//, '')}</span>
                <button className={styles.removeBtn} onClick={() => removeDomain(d.id)}>
                  {t('settings.remove')}
                </button>
              </div>
              <div className={styles.recurringRow}>
                <Switch
                  checked={!!d.recurring_enabled}
                  onChange={(checked) => toggleRecurring(d, checked)}
                  label={t('settings.recurringEnable')}
                />
                <span className={styles.recurringLabel}>{t('settings.recurringEnable')}</span>
              </div>
              {d.recurring_enabled && (
                <div className={styles.recurringOptions}>
                  <div>
                    <Label>{t('settings.recurringInterval')}</Label>
                    <Input
                      type="number"
                      min={1}
                      value={d.recurring_interval_days || DEFAULT_INTERVAL_DAYS}
                      onChange={(e) => changeRecurringInterval(d, parseInt(e.target.value, 10))}
                      style={{ width: 90 }}
                    />
                  </div>
                  <div>
                    <Label>{t('settings.recurringDelivery')}</Label>
                    <select
                      className={styles.select}
                      value={d.recurring_delivery || DEFAULT_DELIVERY}
                      onChange={(e) => changeRecurringDelivery(d, e.target.value)}
                    >
                      <option value="in_app">{t('settings.recurringDeliveryInApp')}</option>
                      <option value="email">{t('settings.recurringDeliveryEmail')}</option>
                    </select>
                  </div>
                </div>
              )}
              {gscConnected && (
                <div className={styles.recurringRow}>
                  <div style={{ width: '100%' }}>
                    <Label>{t('settings.gscLinkProperty')}</Label>
                    <select
                      className={styles.select}
                      style={{ width: '100%' }}
                      value={d.gsc_site_url || ''}
                      onChange={(e) => linkGscSite(d.id, e.target.value)}
                    >
                      <option value="">{t('settings.gscNoProperty')}</option>
                      {gscSites.map((s) => (
                        <option key={s.siteUrl} value={s.siteUrl}>
                          {s.siteUrl}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              )}
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
