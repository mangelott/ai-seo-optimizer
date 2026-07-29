# AI SEO Optimizer

Ferramenta de melhoria de SEO assistida por IA: auditoria técnica, análise de conteúdo, pesquisa de keywords e backlinks, com recomendações priorizadas geradas por IA.

## Stack

- **Frontend**: React + Vite, React Router, Recharts
- **Backend**: Node.js + Express, Postgres, BullMQ + Redis (jobs assíncronos)
- **Dados externos**: [DataForSEO](https://dataforseo.com/) (SERP, keywords, backlinks, crawl técnico)
- **IA**: Claude API (recomendações e priorização)

## Estrutura

```
frontend/   React app (dashboard, auditorias)
backend/    API Express + worker de auditorias
```

## Setup local

### Backend

```bash
cd backend
cp .env.example .env   # preencher DATABASE_URL, REDIS_URL, JWT_SECRET, ANTHROPIC_API_KEY, DATAFORSEO_LOGIN/PASSWORD
npm install
psql "$DATABASE_URL" -f db/schema.sql
npm run dev             # API em http://localhost:4000
node jobs/auditWorker.js   # worker de auditorias (processo separado)
```

Requer Postgres e Redis a correr localmente (ou via Docker).

### Frontend

```bash
cd frontend
cp .env.example .env
npm install
npm run dev              # http://localhost:5173
```

## Fluxo

1. Utilizador regista-se / autentica-se (JWT).
2. Submete um domínio para auditoria (`POST /api/audit`).
3. Um job assíncrono (BullMQ) corre a auditoria técnica, análise de conteúdo, keywords e backlinks via DataForSEO.
4. Claude gera recomendações priorizadas a partir dos resultados.
5. Dashboard mostra o histórico de auditorias e o relatório detalhado por domínio.
