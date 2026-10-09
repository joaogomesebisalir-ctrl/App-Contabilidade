# Publicar a Conta Clara sem subscrição paga

A opção preparada é **Render Free + Supabase Free**. O Render executa Flask e o OCR; o Supabase conserva a base de dados PostgreSQL e os originais num bucket privado. O endereço HTTPS é atribuído pelo Render. Não é necessário comprar domínio.

A aplicação recusa arrancar em modo alojado se faltarem os serviços persistentes ou as chaves de sessão e instalação. O disco local é apenas cache: perder essa cache não apaga a base de dados ou os documentos remotos.

## Limites e escolha dos serviços

No plano gratuito do Supabase, a documentação oficial consultada indica 500 MB de base de dados por projeto, 1 GB de ficheiros e 5 GB de tráfego, com até dois projetos gratuitos. Confira os limites no painel antes de criar o projeto; não selecione organização Pro nem add-ons pagos. Projetos gratuitos podem ser pausados pelo fornecedor. Guarde cópias privadas fora dos fornecedores.

O Blueprint solicita explicitamente `plan: free` no Render, sem discos pagos nem uma base de dados Render. Os serviços gratuitos podem suspender-se quando estão inativos, tornando o primeiro acesso mais lento; não oferecem disponibilidade garantida. Confirme que o ecrã de criação continua a mostrar um serviço gratuito antes de concluir. A página oficial do Render não pôde ser consultada nesta máquina, por restrição de saída de rede; os limites exatos atuais precisam de confirmação no painel.

Supabase não aloja por si o processo Flask/Tesseract. Cloudflare Pages/Workers não executam esta aplicação Python com os binários nativos de OCR como um servidor convencional; Cloudflare Containers requer Workers Paid segundo a documentação oficial consultada. Um túnel temporário para o ambiente de desenvolvimento não é alojamento persistente. Por isso esta preparação conserva o backend completo em Render e a persistência em Supabase.

Fontes: [Supabase — planos e quotas](https://supabase.com/docs/guides/platform/billing-on-supabase), [Render — serviços gratuitos](https://render.com/docs/free), [Cloudflare Containers — preços](https://developers.cloudflare.com/containers/platform/pricing/).

## Passos na tua conta

1. Criar um projeto **Free** no Supabase numa organização gratuita. Escolher uma região europeia e definir uma palavra-passe forte para a base de dados. Não publicar essa palavra-passe nem enviá-la na conversa.
2. No painel **Connect**, copiar o URL de ligação PostgreSQL do **Session pooler**, porta **5432**, com a palavra-passe devidamente codificada no URL. A opção de pooler permite ligações IPv4 sem contratar um add-on IPv4. A aplicação verifica TLS e o nome do servidor.
3. Obter o URL HTTPS do projeto e uma chave de servidor **service_role / secret** nas definições de API. Não usar a chave `anon` ou `publishable`. Estes valores ficam exclusivamente no servidor.
4. Disponibilizar este código no repositório GitHub `joaogomesebisalir-ctrl/App-Contabilidade`, branch `main`. Não carregar `.env`, `instance`, bases de dados, chaves, contas de teste ou documentos pessoais. O GitHub contém apenas código e instruções.
5. No Render, ligar o repositório e criar um **Blueprint** a partir de `render.yaml`. Confirmar o plano **Free**. Preencher `DATABASE_URL`, `SUPABASE_URL` e `SUPABASE_STORAGE_KEY` nas variáveis privadas do serviço. O Blueprint gera `APP_SECRET_KEY` e `APP_SETUP_TOKEN`; manter estes valores privados e estáveis.
6. A aplicação cria o schema privado `conta_clara` e o bucket privado `conta-clara`. As tabelas têm RLS ativada e não concedem acesso a `anon`/`authenticated`; o schema não deve ser adicionado à exposição pública da Data API. O acesso dos dois perfis continua a ser verificado no servidor. No Supabase Storage, uma política restritiva bloqueia as contas cliente neste bucket mesmo quando existem políticas permissivas noutros buckets.
7. Quando o serviço estiver **Live**, abrir o URL HTTPS efetivamente mostrado pelo Render. Na primeira abertura, consultar `APP_SETUP_TOKEN` no painel privado do Render e introduzi-lo no campo **Código de instalação** para criar o administrador com o teu email e palavra-passe. Sem esse código ninguém pode ocupar a primeira conta. O código nunca é incluído no URL nem devolvido pela API.
8. Criar uma entidade e carregar uma fatura. Convidar o contabilista por link autenticado e confirmar as permissões. Não copiar a base de teste para a instalação pública.

## Verificação após publicação

A publicação só está concluída depois de obter um endereço do fornecedor e verificar nesse endereço HTTPS: arranque, autenticação, upload/revisão, importação/associação, convite, descarga e rejeição do acesso privado pelo contabilista. Reiniciar o serviço Render e verificar que as contas e os originais continuam acessíveis. A validação local e os testes com transporte Supabase simulado não substituem esta verificação real.

O teste de ponta a ponta deve usar contas e ficheiros fictícios identificados como teste. Revogar o contabilista de teste e apagar/arquivar os documentos de teste antes de usar dados reais. Não instalar uma conta de demonstração com palavra-passe publicada.

## Cópias e restauro

No backend alojado, a cópia privada contém `dados.json` com os dados de todas as tabelas e `files/` com todos os originais; não contém o URL da base de dados nem a chave Supabase. A cópia é descarregada por um administrador em Definições. O sistema de ficheiros Render é efémero, pelo que cópias CLI guardadas aí não substituem uma cópia descarregada e guardada fora do serviço.

No backend local, as cópias continuam a conter `app.sqlite3` e `files/`. O ZIP PostgreSQL contém um arquivo JSON portátil e os originais; ainda não existe importador automático de restauro para este formato. Conserve também cópias através das ferramentas da base de dados antes de usar a aplicação para documentos reais. Guarde e trate a cópia como informação privada, pois inclui emails e hashes de palavras-passe.

## O que está preparado e o que requer a tua conta

`Dockerfile` instala dependências e OCR português/inglês; `render.yaml` declara o serviço gratuito; o backend PostgreSQL e o armazenamento Supabase privado estão implementados. Os testes locais criam administrador e contabilista fictícios, testam permissões e verificam a perda da cache. Nenhum projeto externo ou subscrição foi criado sem acesso às tuas contas. As chaves devem ser introduzidas no painel privado do alojamento, nunca na conversa ou no GitHub.
