# AI SEO Optimizer

Ferramenta de melhoria de SEO assistida por IA: auditoria técnica, análise de conteúdo, pesquisa de keywords e backlinks, com recomendações priorizadas e prontas a aplicar, geradas por IA.

## Stack

- **Frontend**: React + Vite, React Router, Recharts
- **Backend**: Node.js + Express, Postgres, BullMQ + Redis (jobs assíncronos)
- **Dados externos**: [DataForSEO](https://dataforseo.com/) (SERP, keywords, backlinks, crawl técnico)
- **IA**: Claude API (recomendações e priorização)
- **Billing**: Stripe (subscrições)

## Estrutura

```
frontend/   React app (dashboard, auditorias)
backend/    API Express + worker de auditorias
```

## Setup local

### Backend

```bash
docker compose up -d    # Postgres (porta 5433) + Redis (porta 6379) locais

cd backend
cp .env.example .env   # preencher DATABASE_URL (porta 5433), REDIS_URL, JWT_SECRET, ANTHROPIC_API_KEY,
                        # DATAFORSEO_LOGIN/PASSWORD, STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET,
                        # STRIPE_PRICE_STARTER/PRO/AGENCY
npm install
psql "$DATABASE_URL" -f db/schema.sql
npm run dev             # API em http://localhost:4000
node jobs/auditWorker.js   # worker de auditorias (processo separado)
```

A porta do Postgres no `docker-compose.yml` está mapeada para 5433 (não 5432) para não entrar em conflito com um Postgres local já instalado. Para testar o webhook do Stripe localmente, usa `stripe listen --forward-to localhost:4000/api/billing/webhook`.

### Frontend

```bash
cd frontend
cp .env.example .env
npm install
npm run dev              # http://localhost:5173
```

## Testes

```bash
docker compose up -d
docker exec -i ai-seo-optimizer-postgres-1 psql -U user -d ai_seo_optimizer < backend/db/schema.sql

cd backend
npm test              # unitários + integração (Postgres/Redis reais, sem chamar DataForSEO/Claude/Stripe)
npm run test:unit     # só unitários (scoring, parsing do Claude, config de planos) — sem infra
npm run test:integration   # só o fluxo HTTP completo (auth, limites de plano, quick-scan, billing)
```

Os testes de integração usam `TRUNCATE` nas tabelas antes de correr — não usar a base de dados de produção.

## Fluxo

### Utilizador anónimo (landing page)
1. Insere um URL no quick-scan (`POST /api/quick-scan`, rate-limited por IP).
2. Recebe apenas um teaser (score + nº de problemas encontrados) — os detalhes ficam por trás do registo/pagamento (`GET /api/quick-scan/:id`).
3. Ao registar-se, pode associar o `scanId` à conta (`POST /api/auth/register` aceita `scanId`); os detalhes completos ficam então acessíveis via `GET /api/quick-scan/:id/full`.

### Utilizador autenticado
4. Submete um domínio para auditoria completa (`POST /api/audit`) — sujeito aos limites do plano (nº de auditorias, domínios, categorias incluídas — ver `backend/config/plans.js`).
5. Um job assíncrono (BullMQ) corre a auditoria técnica, conteúdo, keywords e backlinks via DataForSEO — só chama as categorias incluídas no plano do utilizador, para poupar custos de API.
6. Claude gera recomendações estruturadas por issue (severidade, categoria, valor atual, correção sugerida, snippet pronto a copiar).
7. Dashboard mostra o histórico de auditorias e o relatório detalhado por domínio, com um "Fix Card" por problema e botão de copiar.

### Billing
- `POST /api/billing/checkout` — cria uma sessão de Stripe Checkout para o plano escolhido.
- `POST /api/billing/portal` — abre o portal de self-service do Stripe (cancelar/alterar plano, faturas).
- `POST /api/billing/webhook` — sincroniza o plano do utilizador com o estado da subscrição no Stripe.

## Roadmap

- **Fase 1 (atual)**: correções geradas pela IA, prontas a copiar/colar manualmente.
- **Fase 2**: aplicação automática de correções via integração direta com CMS (WordPress primeiro).
