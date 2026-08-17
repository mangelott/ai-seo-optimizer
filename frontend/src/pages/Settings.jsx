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
  const [wpForms, setWpForms] = useState({});
  const [wpErrors, setWpErrors] = useState({});
  const [wpBusy, setWpBusy] = useState({});
  const [plan, setPlan] = useState(null);
  const [team, setTeam] = useState(null);
  const [teamMembers, setTeamMembers] = useState([]);
  const [teamName, setTeamName] = useState('');
  const [inviteEmail, setInviteEmail] = useState('');
  const [teamError, setTeamError] = useState('');
  const [teamBusy, setTeamBusy] = useState(false);

  function loadTeam() {
    api.get('/teams/me').then(({ data }) => {
      setTeam(data.team);
      setTeamMembers(data.members || []);
    });
  }

  useEffect(() => {
    api.get('/auth/me').then(({ data }) => {
      setName(data.name || '');
      setEmail(data.email || '');
      setPlan(data.plan);
    });
    api.get('/domains').then(({ data }) => setDomains(data));
    api.get('/gsc/status').then(({ data }) => setGscConnected(data.connected));
    loadTeam();

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

  function updateWpForm(domainId, field, value) {
    setWpForms((f) => ({ ...f, [domainId]: { ...f[domainId], [field]: value } }));
  }

  async function connectWp(domainId) {
    const form = wpForms[domainId] || {};
    setWpBusy((b) => ({ ...b, [domainId]: true }));
    setWpErrors((e) => ({ ...e, [domainId]: '' }));
    try {
      const { data } = await api.patch(`/wordpress/domains/${domainId}/connect`, {
        wpUrl: form.wpUrl,
        wpUsername: form.wpUsername,
        wpAppPassword: form.wpAppPassword,
      });
      setDomains((d) => d.map((x) => (x.id === domainId ? { ...x, ...data } : x)));
      setWpForms((f) => ({ ...f, [domainId]: {} }));
    } catch (err) {
      setWpErrors((e) => ({ ...e, [domainId]: err.response?.data?.error || 'Error' }));
    } finally {
      setWpBusy((b) => ({ ...b, [domainId]: false }));
    }
  }

  async function toggleAutoFix(domainId, enabled) {
    const { data } = await api.patch(`/wordpress/domains/${domainId}/toggle`, { autoFixEnabled: enabled });
    setDomains((d) => d.map((x) => (x.id === domainId ? { ...x, ...data } : x)));
  }

  async function disconnectWp(domainId) {
    await api.delete(`/wordpress/domains/${domainId}/disconnect`);
    setDomains((d) =>
      d.map((x) => (x.id === domainId ? { ...x, wp_url: null, wp_username: null, auto_fix_enabled: false } : x))
    );
  }

  async function createTeam(e) {
    e.preventDefault();
    setTeamBusy(true);
    setTeamError('');
    try {
      const { data } = await api.post('/teams', { name: teamName });
      setTeam(data.team);
      setTeamName('');
    } catch (err) {
      setTeamError(err.response?.data?.error || 'Error');
    } finally {
      setTeamBusy(false);
    }
  }

  async function inviteMember(e) {
    e.preventDefault();
    setTeamBusy(true);
    setTeamError('');
    try {
      await api.post('/teams/invite', { email: inviteEmail });
      setInviteEmail('');
      loadTeam();
    } catch (err) {
      setTeamError(err.response?.data?.error || 'Error');
    } finally {
      setTeamBusy(false);
    }
  }

  async function removeMember(memberId) {
    await api.delete(`/teams/members/${memberId}`);
    loadTeam();
  }

  async function updateWhiteLabel(field, value) {
    const { data } = await api.patch('/teams', { [field]: value });
    setTeam(data.team);
  }

  async function deleteTeam() {
    if (!window.confirm(t('settings.teamDeleteConfirm'))) return;
    await api.delete('/teams');
    setTeam(null);
    setTeamMembers([]);
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
              <Label htmlFor="profile-name">{t('settings.name')}</Label>
              <Input id="profile-name" value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="profile-email">{t('settings.email')}</Label>
              <Input id="profile-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
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
              <Label htmlFor="current-password">{t('settings.currentPassword')}</Label>
              <Input id="current-password" type="password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="new-password">{t('settings.newPassword')}</Label>
              <Input id="new-password" type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} minLength={8} />
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
                    <Label htmlFor={`recurring-interval-${d.id}`}>{t('settings.recurringInterval')}</Label>
                    <Input
                      id={`recurring-interval-${d.id}`}
                      type="number"
                      min={1}
                      value={d.recurring_interval_days || DEFAULT_INTERVAL_DAYS}
                      onChange={(e) => changeRecurringInterval(d, parseInt(e.target.value, 10))}
                      style={{ width: 90 }}
                    />
                  </div>
                  <div>
                    <Label htmlFor={`recurring-delivery-${d.id}`}>{t('settings.recurringDelivery')}</Label>
                    <select
                      id={`recurring-delivery-${d.id}`}
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
                    <Label htmlFor={`gsc-property-${d.id}`}>{t('settings.gscLinkProperty')}</Label>
                    <select
                      id={`gsc-property-${d.id}`}
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
              <div className={styles.recurringRow}>
                <div style={{ width: '100%' }}>
                  <Label>{t('settings.wpTitle')}</Label>
                  {d.wp_url ? (
                    <>
                      <p className={styles.dangerText} style={{ marginTop: 4 }}>
                        {t('settings.wpConnectedTo', { url: d.wp_url })}
                      </p>
                      <div className={styles.recurringRow} style={{ marginTop: 8, paddingTop: 0, borderTop: 'none' }}>
                        <Switch
                          checked={!!d.auto_fix_enabled}
                          onChange={(checked) => toggleAutoFix(d.id, checked)}
                          label={t('settings.wpAutoFixEnable')}
                        />
                        <span className={styles.recurringLabel}>{t('settings.wpAutoFixEnable')}</span>
                      </div>
                      <Button
                        variant="secondary"
                        size="sm"
                        type="button"
                        style={{ marginTop: 10 }}
                        onClick={() => disconnectWp(d.id)}
                      >
                        {t('settings.wpDisconnect')}
                      </Button>
                    </>
                  ) : (
                    <>
                      <p className={styles.dangerText} style={{ marginTop: 4 }}>
                        {t('settings.wpDesc')}{' '}
                        <a href="/ai-seo-optimizer-connector.php" download>
                          {t('settings.wpDownloadPlugin')}
                        </a>
                      </p>
                      <div className={styles.recurringOptions} style={{ marginTop: 10, flexWrap: 'wrap' }}>
                        <div>
                          <Label htmlFor={`wp-url-${d.id}`}>{t('settings.wpUrl')}</Label>
                          <Input
                            id={`wp-url-${d.id}`}
                            placeholder="https://yoursite.com"
                            value={wpForms[d.id]?.wpUrl || ''}
                            onChange={(e) => updateWpForm(d.id, 'wpUrl', e.target.value)}
                          />
                        </div>
                        <div>
                          <Label htmlFor={`wp-username-${d.id}`}>{t('settings.wpUsername')}</Label>
                          <Input
                            id={`wp-username-${d.id}`}
                            value={wpForms[d.id]?.wpUsername || ''}
                            onChange={(e) => updateWpForm(d.id, 'wpUsername', e.target.value)}
                          />
                        </div>
                        <div>
                          <Label htmlFor={`wp-app-password-${d.id}`}>{t('settings.wpAppPassword')}</Label>
                          <Input
                            id={`wp-app-password-${d.id}`}
                            type="password"
                            value={wpForms[d.id]?.wpAppPassword || ''}
                            onChange={(e) => updateWpForm(d.id, 'wpAppPassword', e.target.value)}
                          />
                        </div>
                      </div>
                      <Button
                        size="sm"
                        type="button"
                        style={{ marginTop: 10 }}
                        onClick={() => connectWp(d.id)}
                        disabled={wpBusy[d.id]}
                      >
                        {wpBusy[d.id] ? t('common.loading') : t('settings.wpConnect')}
                      </Button>
                      {wpErrors[d.id] && <p className={styles.error}>{wpErrors[d.id]}</p>}
                    </>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {plan === 'agency' && (
        <div className={styles.card}>
          <h3 style={{ fontSize: 18, fontWeight: 600, margin: 0, color: 'var(--text)' }}>{t('settings.team')}</h3>

          {!team ? (
            <>
              <p className={styles.dangerText} style={{ marginTop: 4 }}>{t('settings.teamDesc')}</p>
              <form onSubmit={createTeam} className={styles.recurringOptions} style={{ marginTop: 12 }}>
                <div style={{ flex: 1 }}>
                  <Label htmlFor="team-name">{t('settings.teamName')}</Label>
                  <Input id="team-name" value={teamName} onChange={(e) => setTeamName(e.target.value)} required />
                </div>
                <Button type="submit" size="sm" style={{ alignSelf: 'flex-end' }} disabled={teamBusy}>
                  {t('settings.teamCreate')}
                </Button>
              </form>
              {teamError && <p className={styles.error}>{teamError}</p>}
            </>
          ) : (
            <>
              <p className={styles.dangerText} style={{ marginTop: 4 }}>{team.name}</p>

              <div className={styles.domainsList} style={{ marginTop: 12 }}>
                {teamMembers.map((m) => (
                  <div className={styles.domainRow} key={m.id}>
                    <span style={{ fontSize: 14, color: 'var(--text)' }}>
                      {m.invited_email} {m.accepted_at ? '' : `(${t('settings.teamPending')})`}
                    </span>
                    {team.isOwner && (
                      <button className={styles.removeBtn} onClick={() => removeMember(m.id)}>
                        {t('settings.remove')}
                      </button>
                    )}
                  </div>
                ))}
              </div>

              {team.isOwner && (
                <>
                  <form onSubmit={inviteMember} className={styles.recurringOptions} style={{ marginTop: 16 }}>
                    <div style={{ flex: 1 }}>
                      <Label htmlFor="team-invite-email">{t('settings.teamInviteEmail')}</Label>
                      <Input id="team-invite-email" type="email" value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} required />
                    </div>
                    <Button type="submit" size="sm" style={{ alignSelf: 'flex-end' }} disabled={teamBusy}>
                      {t('settings.teamInvite')}
                    </Button>
                  </form>
                  {teamError && <p className={styles.error}>{teamError}</p>}

                  <div className={styles.recurringRow}>
                    <div style={{ width: '100%' }}>
                      <Label>{t('settings.teamWhiteLabel')}</Label>
                      <div className={styles.recurringOptions} style={{ marginTop: 6, flexWrap: 'wrap' }}>
                        <div>
                          <Label htmlFor="team-logo-url">{t('settings.teamLogoUrl')}</Label>
                          <Input
                            id="team-logo-url"
                            placeholder="https://yourbrand.com/logo.png"
                            defaultValue={team.white_label_logo_url || ''}
                            onBlur={(e) => updateWhiteLabel('whiteLabelLogoUrl', e.target.value)}
                          />
                        </div>
                        <div>
                          <Label htmlFor="team-brand-color">{t('settings.teamBrandColor')}</Label>
                          <Input
                            id="team-brand-color"
                            type="color"
                            defaultValue={team.white_label_brand_color || '#5b4fd6'}
                            onBlur={(e) => updateWhiteLabel('whiteLabelBrandColor', e.target.value)}
                            style={{ width: 60, padding: 4 }}
                          />
                        </div>
                      </div>
                    </div>
                  </div>

                  <Button variant="danger" size="sm" style={{ marginTop: 12 }} onClick={deleteTeam}>
                    {t('settings.teamDelete')}
                  </Button>
                </>
              )}
            </>
          )}
        </div>
      )}

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
