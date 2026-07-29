import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../api/client';

export default function Dashboard() {
  const [domain, setDomain] = useState('');
  const [audits, setAudits] = useState([]);
  const [error, setError] = useState('');

  async function loadAudits() {
    const { data } = await api.get('/audit');
    setAudits(data);
  }

  useEffect(() => {
    loadAudits();
  }, []);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    try {
      await api.post('/audit', { domain });
      setDomain('');
      loadAudits();
    } catch {
      setError('Could not start audit');
    }
  }

  return (
    <div className="dashboard">
      <h1>SEO Audits</h1>
      <form onSubmit={handleSubmit}>
        <input
          type="url"
          placeholder="https://example.com"
          value={domain}
          onChange={(e) => setDomain(e.target.value)}
          required
        />
        <button type="submit">Run audit</button>
      </form>
      {error && <p className="error">{error}</p>}

      <ul className="audit-list">
        {audits.map((audit) => (
          <li key={audit.id}>
            <Link to={`/audits/${audit.id}`}>
              {audit.domain} — {audit.status} {audit.score != null && `(score: ${audit.score})`}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
