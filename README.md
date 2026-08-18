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
npm run test:unit     # só unitários (scoring, parsing do Claude, config de planos, plugin WP) — sem infra
npm run test:integration   # todo o fluxo HTTP (auth, limites de plano, quick-scan, billing, equipas, WordPress, GSC, segurança)
npm run lint:php       # lint de sintaxe ao plugin WordPress via Docker (não corre com `npm test`)
```

Os testes de integração usam `TRUNCATE` nas tabelas antes de correr — não usar a base de dados de produção. Correm sempre sequenciais (`--test-concurrency=1`): vários ficheiros fazem `TRUNCATE` no `test.before`, e corrê-los em paralelo provoca falhas aleatórias por um ficheiro apagar dados que outro está a usar a meio.

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

## Login com Google

Código pronto em `backend/routes/auth.js` (`GET /api/auth/google`, `GET /api/auth/google/callback`) e `backend/services/google.js`. Para ativar:

1. Cria um projeto em [Google Cloud Console](https://console.cloud.google.com/) → **APIs & Services → Credentials**.
2. Configura o **OAuth consent screen** (tipo External, adiciona o teu email como test user enquanto não estiver em produção).
3. Cria uma credencial **OAuth 2.0 Client ID**, tipo **Web application**.
4. Em **Authorized redirect URIs**, adiciona: `http://localhost:4000/api/auth/google/callback` (dev) e o equivalente em produção (`https://<teu-backend>/api/auth/google/callback`).
5. Copia o **Client ID** e **Client Secret** para `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` no `.env`; `GOOGLE_REDIRECT_URI` deve ser exatamente o URI autorizado no passo 4.

Sem isto configurado, o botão "Continuar com Google" leva a um ecrã de erro do próprio Google — não quebra o resto da app.

## Recuperar password por email

Código pronto em `backend/routes/auth.js` (`POST /api/auth/forgot-password`, `POST /api/auth/reset-password`) e `backend/services/email.js`, usando [Resend](https://resend.com/). Para ativar:

1. Cria conta em resend.com e gera uma API key.
2. Preenche `RESEND_API_KEY` no `.env`.
3. Para `EMAIL_FROM`, podes usar o domínio de sandbox deles (`onboarding@resend.dev`) para testar sem verificar domínio próprio; para produção, verifica o teu domínio no Resend e usa um endereço desse domínio.

Sem `RESEND_API_KEY` válida, o pedido de recuperação continua a responder com sucesso (por segurança, nunca revela se o email existe) mas o envio falha silenciosamente (fica registado nos logs do servidor).

## Google Search Console

Código pronto em `backend/routes/gsc.js` e `backend/services/googleSearchConsole.js` — liga a conta Google do utilizador (scope `webmasters.readonly`) e mostra cliques, impressões, CTR e posição média reais junto de cada auditoria. É um fluxo OAuth separado do login com Google (scopes e redirect URI diferentes), mas pode usar o mesmo Client ID/Secret. Para ativar:

1. No mesmo projeto do Google Cloud Console usado para o login, vai a **APIs & Services → Library** e ativa a **Google Search Console API**.
2. Em **APIs & Services → Credentials**, na credencial OAuth já existente, adiciona em **Authorized redirect URIs**: `http://localhost:4000/api/gsc/callback` (dev) e o equivalente em produção (`https://<teu-backend>/api/gsc/callback`).
3. Preenche `GSC_REDIRECT_URI` no `.env` com esse mesmo URI (usa `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` já existentes, não precisa de credenciais novas).

Sem isto configurado, o botão "Ligar Google Search Console" nas Definições leva a um ecrã de erro do próprio Google — não quebra o resto da app. Depois de ligado, cada domínio monitorizado pode ser associado a uma propriedade verificada da Search Console (o utilizador só vê propriedades onde já tem acesso confirmado na própria conta Google).

## Core Web Vitals

Código pronto em `backend/services/coreWebVitals.js`, integrado na auditoria técnica junto de `technical`/`content`/`backlinks` (sempre que a categoria `technical` está incluída no plano). Devolve LCP, INP e CLS já classificados (`good` / `needs-improvement` / `poor`) segundo os thresholds publicados pela Google, mais o `performanceScore` geral. Tenta primeiro o endpoint Lighthouse do DataForSEO (`on_page/lighthouse/live/json`) e, se a conta não tiver acesso a esse endpoint (ou a chamada falhar por qualquer razão), recorre automaticamente à [PageSpeed Insights API](https://developers.google.com/speed/docs/insights/v5/get-started) da Google, que é gratuita — preferindo aí dados de campo reais (CrUX) e só caindo para dados de laboratório (Lighthouse simulado) quando não há CrUX disponível para o URL. Como as restantes categorias, uma falha nunca bloqueia o resto da auditoria (`core_web_vitals` fica `null` no relatório).

Para ativar a PageSpeed Insights API (usada como fallback, ou como única fonte se a conta DataForSEO não tiver Lighthouse):
1. Em [Google Cloud Console](https://console.cloud.google.com/) → **APIs & Services → Library**, ativa a **PageSpeed Insights API**.
2. Em **APIs & Services → Credentials**, cria uma **API key** (não precisa de OAuth — é uma chamada não autenticada por utilizador).
3. Preenche `GOOGLE_PAGESPEED_API_KEY` no `.env`.

Sem `GOOGLE_PAGESPEED_API_KEY` (e sem acesso ao Lighthouse do DataForSEO), `core_web_vitals` fica simplesmente `null` no relatório — não quebra o resto da auditoria.

## Validação de robots.txt e sitemap.xml

Código pronto em `backend/services/crawlability.js`, integrado na auditoria técnica junto de `technical`/`content`/`backlinks`/Core Web Vitals (sempre que a categoria `technical` está incluída no plano). São só pedidos HTTP simples (sem custo de API paga): busca `{domínio}/robots.txt`, faz parse das diretivas `Disallow`/`Allow`/`Sitemap`, e verifica se a homepage fica bloqueada por engano (`Disallow: /` para `User-agent: *` sem um `Allow: /` a anular). Depois busca o sitemap (o primeiro URL declarado via `Sitemap:` no robots.txt, ou `{domínio}/sitemap.xml` por defeito), valida que é XML bem formado (`<urlset>` ou `<sitemapindex>`), conta os URLs, e testa uma amostra em busca de URLs mortos (404). Como as restantes categorias, uma falha nunca bloqueia o resto da auditoria — ficam `null` no relatório (`robots_txt_result` / `sitemap_result`). A IA gera uma correção de severidade alta sempre que a homepage está bloqueada, ou o sitemap não existe/está malformado, ou tem URLs mortos na amostra — são problemas que impedem indexação por completo.

## Correção automática via WordPress

Código pronto em `backend/routes/wordpress.js`, `backend/services/wordpress.js` e `backend/services/encryption.js`. Deixa o utilizador aplicar, com um clique, as correções que a IA gera (título, meta description, alt text de imagens, dados estruturados) diretamente no WordPress do site auditado — sem copiar/colar. Funciona através de um plugin companheiro (`wordpress-plugin/ai-seo-optimizer-connector.php`, também servido em `frontend/public/ai-seo-optimizer-connector.php` para download direto nas Definições), porque o WordPress core não expõe meta description, alt text nem schema via REST API sem um plugin.

Para o utilizador final ativar (por domínio, nas Definições da app):
1. Descarrega o plugin (`ai-seo-optimizer-connector.php`) a partir das Definições e instala-o no WordPress (**Plugins → Adicionar novo → Carregar plugin**), depois ativa-o.
2. Cria uma **Application Password** no WordPress (**Utilizadores → Perfil → Application Passwords**) para o utilizador que vai autenticar os pedidos.
3. Nas Definições da app, introduz o URL do site, o username WordPress e a Application Password gerada, e liga.
4. Ativa o toggle "Ativar correção automática" para esse domínio — a partir daí, cada fix compatível (title, meta description, alt text, schema) mostra um botão "Aplicar automaticamente" no relatório.

Para ativar isto no teu backend (uma vez, não é por utilizador):
1. Preenche `WP_CREDENTIALS_ENCRYPTION_KEY` no `.env` com uma string aleatória longa (ex.: `openssl rand -hex 32`) — é usada para cifrar as Application Passwords dos utilizadores em repouso (`pgp_sym_encrypt`/`pgp_sym_decrypt`, extensão `pgcrypto` já incluída no schema). No Render, o `render.yaml` já gera este valor automaticamente (`generateValue: true`).

Sem o plugin instalado no site do utilizador, a ligação falha com uma mensagem clara a pedir para o instalar — não quebra o resto da app. Correções sem um campo WordPress claro (ex.: sugestões de keywords/backlinks) continuam apenas como "copiar/colar", como seria de esperar.

## Correção automática via GitHub (sites que não são WordPress)

Código pronto em `backend/routes/github.js` e `backend/services/github.js`. Resolve a limitação de o auto-fix só funcionar em WordPress: liga um repositório GitHub a um domínio e cada fix compatível (title, meta description, alt text — os mesmos que o WordPress cobre, sempre que há um `currentValue` literal para procurar no código-fonte) abre um **Pull Request** para revisão humana, nunca faz commit direto a `main`. Localizar o ficheiro certo no repositório é o problema que o WordPress resolve de graça (`url_to_postid()`) e o GitHub não — por isso o fluxo é: pesquisa automática no código-fonte pelo texto atual (GitHub code search) e, se não encontrar exatamente um ficheiro, pede ao utilizador para indicar o caminho manualmente (com a lista de candidatos, se houver mais do que um).

Se um domínio tiver WordPress **e** GitHub ligados ao mesmo tempo, o WordPress tem prioridade — a app assume que só um dos dois é o "site real".

Para ativar isto no teu backend (uma vez, não é por utilizador) — precisas de criar uma **GitHub App**:
1. Em [github.com/settings/apps](https://github.com/settings/apps) (ou nas definições da tua organização) → **New GitHub App**.
2. **Homepage URL**: o URL do teu frontend. **Callback URL**: não é necessário (não usamos OAuth de utilizador). **Setup URL** (em "Post installation"): `https://<o-teu-backend>/api/github/callback` (dev: `http://localhost:4000/api/github/callback`) — marca "Redirect on update" também.
3. Em **Webhook**, desmarca "Active" (não precisamos de eventos).
4. Em **Permissions → Repository permissions**: `Contents` → Read and write; `Pull requests` → Read and write. (`Metadata` fica Read-only por defeito.)
5. Em "Where can this GitHub App be installed?", escolhe conforme preferires (qualquer conta, ou só a tua).
6. Cria a app. Anota o **App ID** (no topo da página) e o **slug** (a parte final do URL da app, ex. `github.com/apps/o-teu-slug`).
7. Em **Private keys**, gera uma nova chave privada — descarrega o `.pem`. Para colocar no `.env`, converte as quebras de linha em `\n` literais (uma linha só): `awk '{printf "%s\\n", $0}' a-tua-chave.pem`.
8. Preenche `GITHUB_APP_ID`, `GITHUB_APP_SLUG`, `GITHUB_APP_PRIVATE_KEY` no `.env` (ou nas env vars do Render — `render.yaml` já as tem marcadas como `sync: false`).

Para o utilizador final ativar (por domínio, nas Definições da app, só quando o domínio **não** já tem WordPress ligado):
1. Liga a conta GitHub uma vez (botão "Ligar GitHub" nas Definições) — abre o ecrã de instalação da GitHub App, onde escolhe a que repositórios dar acesso.
2. Por domínio, escolhe o repositório na lista.
3. Ativa o toggle "Ativar correção automática" — a partir daí, os fixes compatíveis mostram "Aplicar automaticamente", que abre um PR em vez de aplicar direto.

Sem a app configurada, o botão "Ligar GitHub" leva a um ecrã de erro do próprio GitHub — não quebra o resto da app.

## Contas de equipa e white-label (plano Agency)

Código pronto em `backend/routes/teams.js`, `backend/services/teams.js` — não precisa de nenhuma configuração externa, funciona logo que o utilizador esteja no plano Agency. Um utilizador Agency cria uma equipa nas Definições, convida colegas por email; se o colega já tiver conta fica ligado de imediato, senão fica associado automaticamente assim que essa pessoa se registar ou fizer login com esse email. Todos os membros de uma equipa:

- Partilham a mesma visibilidade de auditorias e domínios monitorizados (workspace único).
- Usam os limites do plano Agency (ilimitado) para criar auditorias, mesmo que a conta pessoal deles seja Free/Starter/Pro — só o dono da equipa precisa de pagar Agency.
- Podem exportar relatórios PDF com o logótipo e a cor de marca definidos pelo dono da equipa (`white_label_logo_url` / `white_label_brand_color`).

Gestão da equipa (convidar, remover membros, editar white-label, eliminar equipa) é restrita ao dono; todos os membros só podem ver/consultar.

## Deploy

### Backend + worker (Render)

Há um blueprint pronto em [`render.yaml`](render.yaml) — cria o backend, o worker, Postgres e Redis, todos ligados entre si.

1. Em [dashboard.render.com](https://dashboard.render.com/) → **New +** → **Blueprint**.
2. Liga a conta GitHub e escolhe o repositório `ai-seo-optimizer`. O Render deteta o `render.yaml` automaticamente.
3. No ecrã de review, o Render pede para preencheres as variáveis marcadas `sync: false` (não geradas automaticamente): `FRONTEND_URL`, `ANTHROPIC_API_KEY`, `DATAFORSEO_LOGIN`/`PASSWORD`, `STRIPE_SECRET_KEY`/`WEBHOOK_SECRET`/`PRICE_*`, `GOOGLE_CLIENT_ID`/`SECRET`/`REDIRECT_URI`, `GSC_REDIRECT_URI`, `RESEND_API_KEY`, `EMAIL_FROM`. `DATABASE_URL`, `REDIS_URL` e `JWT_SECRET` ficam tratados automaticamente pelo blueprint.
4. Aplica o blueprint. O schema da base de dados é aplicado sozinho antes de cada deploy (`preDeployCommand: npm run migrate`).
5. Depois do primeiro deploy, copia o URL público do serviço `ai-seo-optimizer-api` (algo como `https://ai-seo-optimizer-api.onrender.com`) — vais precisar dele nos passos seguintes.

### Frontend (Vercel)

1. Em [vercel.com](https://vercel.com/) → **Add New → Project** → importa o mesmo repositório.
2. **Root Directory**: `frontend` (o Vite é detetado automaticamente).
3. Adiciona a env var `VITE_API_URL` = `https://<o-teu-backend-no-render>.onrender.com/api`.
4. Deploy. O `vercel.json` já tem o rewrite necessário para o React Router funcionar em qualquer rota (refresh numa página como `/dashboard` sem dar 404).

### Últimos ajustes depois de ambos estarem no ar

- No Render, atualiza `FRONTEND_URL` do backend para o domínio real do Vercel (usado nos redirects do Google OAuth, nos links de recuperação de password, e nas URLs de sucesso/cancelamento do Stripe Checkout).
- No Stripe Dashboard → Webhooks, atualiza (ou cria) o endpoint para `https://<backend-no-render>/api/billing/webhook` e copia o novo signing secret para `STRIPE_WEBHOOK_SECRET`.
- No Google Cloud Console, atualiza o **Authorized redirect URI** da credencial OAuth para `https://<backend-no-render>/api/auth/google/callback`, igual ao `GOOGLE_REDIRECT_URI` (e, se a Search Console estiver ativa, adiciona também `https://<backend-no-render>/api/gsc/callback`, igual ao `GSC_REDIRECT_URI`).

## Roadmap

- **Fase 1 (atual)**: correções geradas pela IA, prontas a copiar/colar manualmente.
- **Fase 2**: aplicação automática de correções via integração direta com CMS (WordPress primeiro).
