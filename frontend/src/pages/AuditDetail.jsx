import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import api from '../api/client';

export default function AuditDetail() {
  const { id } = useParams();
  const [audit, setAudit] = useState(null);

  useEffect(() => {
    api.get(`/audit/${id}`).then(({ data }) => setAudit(data));
  }, [id]);

  if (!audit) return <p>Loading...</p>;

  return (
    <div className="audit-detail">
      <h1>{audit.domain}</h1>
      <p>Status: {audit.status}</p>

      {audit.ai_recommendations && (
        <section>
          <h2>Recommendations</h2>
          <pre>{audit.ai_recommendations}</pre>
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
