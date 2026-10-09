# Cloudflare Workers + Supabase

A interface e a API são publicadas num Worker com assets. A interface estática abre sem esperar pelo arranque de uma instância Render. Contas, documentos e originais privados continuam no mesmo Supabase. Não se criam recursos pagos; aplicam-se as quotas dos planos gratuitos de ambos os fornecedores. O Supabase gratuito pode ser suspenso por inatividade e as quotas devem ser acompanhadas.

PDF.js, Tesseract português/inglês, jsQR e leitura de Excel são servidos no mesmo domínio, com versões fixas no lockfile. A extração corre numa thread do navegador: mantenha o separador aberto até terminar. O primeiro OCR descarrega motor/idiomas, depois utiliza a cache. Uma falha de leitura mantém o original e permite revisão manual. Extrações pendentes são retomadas ao abrir a conta de administrador. Não há envio de documentos a serviços externos de IA.

A função Supabase `conta-password` executa scrypt, conservando hashes Werkzeug existentes. Só aceita a chave de serviço do servidor, guardada também no segredo privado Supabase `CONTA_BACKEND_KEY`. As funções SQL `cc_query`, `cc_scope` e `cc_snapshot` só podem ser executadas por `service_role`; os utilizadores não recebem esta chave. São criadas com o proprietário limitado da base privada. Os pagamentos são protegidos por triggers e bloqueios transacionais, incluindo pedidos simultâneos. Downloads verificam sessão, permissões atuais e SHA-256. O ZIP de exportação/cópia é gerado no navegador; a cópia privada inclui hashes e originais apagados.

## Preparar e testar

Na raiz do repositório, com Node 24 e a `.venv` Python existente:

```sh
npm --cache /tmp/conta-npm ci --prefix cloud
npm --cache /tmp/conta-npm run build --prefix cloud
npm --cache /tmp/conta-npm test --prefix cloud
XDG_CONFIG_HOME=/tmp/conta-wrangler cloud/node_modules/.bin/wrangler deploy --dry-run --config cloud/wrangler.jsonc
```

Os testes integrados precisam de PostgreSQL 17 descartável em loopback. Configure `PG_TEST_URL` **apenas para essa base de teste**, nunca para produção. `cloud/scripts/test-server.mjs` cria e apaga um schema exclusivo, usa a API real do Worker, PostgreSQL real e armazenamento privado simulado; não lê credenciais nem dados de produção. As funções públicas de teste usam nomes fixos: execute os testes sequencialmente na base descartável. O servidor suporta apenas loopback.

```sh
.venv/bin/python -m pytest tests -q
node cloud/scripts/test-workerd.mjs
```

## Publicar a migração autorizada

Nas definições privadas do ambiente configure `CLOUDFLARE_API_TOKEN` com **Account / Workers Scripts / Edit** e **Account / Account Settings / Read** para a conta escolhida. O ambiente já precisa de `SUPABASE_ACCESS_TOKEN` e `RENDER_API_KEY` com acesso aos projetos existentes. Nunca coloque chaves no Git ou na conversa. Se o token permitir várias contas, escolha a conta com a variável não secreta `CLOUDFLARE_ACCOUNT_ID`.

```sh
python cloud/scripts/deploy.py --check-only
python cloud/scripts/deploy.py
```

`python cloud/scripts/deploy.py --prepare-supabase` prepara apenas a API/autenticação Supabase, sem publicar no Cloudflare.

O script reutiliza as definições privadas do serviço Render existente, instala as funções Supabase sem apagar dados, publica `conta-clara` e configura os segredos diretamente pela API. Mostra o domínio `workers.dev` real devolvido pela conta. Não publica os valores secretos nem guarda ficheiros com credenciais. `--check-only` verifica acesso sem alterar os fornecedores.

Depois de publicar, confirme `/health`, a sessão, autenticação e os fluxos de documentos no domínio real. Conserve Render até essa validação estar concluída. Não é possível alterar o domínio `onrender.com` para ser servido diretamente pelo Cloudflare; distribua o novo link. Este documento e uma compilação local não comprovam publicação nem testes no domínio público.

Para configurar manualmente, os segredos do Worker são `APP_SECRET_KEY`, `APP_SETUP_TOKEN`, `SUPABASE_URL` e `SUPABASE_STORAGE_KEY`. Os valores não secretos `APP_DB_SCHEMA` e `SUPABASE_BUCKET` estão no `wrangler.jsonc`. Não utilize `.dev.vars` de produção no teste local.
