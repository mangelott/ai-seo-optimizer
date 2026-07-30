import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import api from '../api/client';

const CATEGORY_LABELS = {
  technical: 'Technical',
  content: 'Content',
  keywords: 'Keywords',
  backlinks: 'Backlinks',
};

function FixCard({ fix }) {
  const [copied, setCopied] = useState(false);

  function handleCopy() {
    navigator.clipboard.writeText(fix.snippet ?? fix.suggestedFix);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div className={`fix-card severity-${fix.severity}`}>
      <div className="fix-header">
        <span className="fix-severity">{fix.severity}</span>
        <span className="fix-category">{CATEGORY_LABELS[fix.category] ?? fix.category}</span>
      </div>
      <p className="fix-issue">{fix.issue}</p>
      {fix.currentValue && (
        <p className="fix-current"><strong>Atual:</strong> {fix.currentValue}</p>
      )}
      <p className="fix-suggested"><strong>Sugestão:</strong> {fix.suggestedFix}</p>
      {fix.snippet && <pre className="fix-snippet">{fix.snippet}</pre>}
      <button type="button" onClick={handleCopy}>
        {copied ? 'Copiado!' : 'Copiar correção'}
      </button>
    </div>
  );
}

export default function AuditDetail() {
  const { id } = useParams();
  const [audit, setAudit] = useState(null);

  useEffect(() => {
    api.get(`/audit/${id}`).then(({ data }) => setAudit(data));
  }, [id]);

  if (!audit) return <p>Loading...</p>;

  const fixes = Array.isArray(audit.ai_recommendations) ? audit.ai_recommendations : [];

  return (
    <div className="audit-detail">
      <h1>{audit.domain}</h1>
      <p>Status: {audit.status}</p>

      {fixes.length > 0 && (
        <section>
          <h2>Recomendações</h2>
          {fixes.map((fix, i) => (
            <FixCard key={i} fix={fix} />
          ))}
        </section>
      )}

      {audit.content_result && (
        <section>
          <h2>Content</h2>
          <pre>{JSON.stringify(audit.content_result, null, 2)}</pre>
        </section>
      )}

      {audit.technical_result && (
        <section>
          <h2>Technical</h2>
          <pre>{JSON.stringify(audit.technical_result, null, 2)}</pre>
        </section>
      )}

      {audit.keyword_result && (
        <section>
          <h2>Keywords</h2>
          <pre>{JSON.stringify(audit.keyword_result, null, 2)}</pre>
        </section>
      )}

      {audit.backlink_result && (
        <section>
          <h2>Backlinks</h2>
          <pre>{JSON.stringify(audit.backlink_result, null, 2)}</pre>
        </section>
      )}
    </div>
  );
}
