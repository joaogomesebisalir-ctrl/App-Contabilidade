# Conta Clara

Aplicação web em português de Portugal para documentos financeiros, reconciliação bancária e colaboração com um contabilista, com obras, materiais e contactos privados. Usa Flask, SQLite e armazenamento privado em disco no modo local. Para alojamento com disco temporário, suporta PostgreSQL e armazenamento privado Supabase; consulte [alojamento gratuito](deploy/GRATUITO.md). Os dados persistem entre reinícios; não existem contas de demonstração nem dados pré-carregados.

## Executar

Requisitos: Python 3.12, Tesseract e Poppler (`tesseract-ocr`, `poppler-utils` em Debian/Ubuntu). Chromium é usado apenas nos testes de navegador.

```sh
cd /workspace/App-Contabilidade
bash scripts/setup.sh
bash scripts/start.sh
```

O processo usa a porta 8000, configurável com `PORT`. `APP_HOST` define a interface de escuta e é `127.0.0.1` por defeito. Na primeira abertura, crie a conta de administrador e depois uma entidade nas Definições. Nunca publique uma instalação vazia antes de criar o administrador num acesso controlado. As palavras-passe precisam de 12 caracteres; não existe uma palavra-passe padrão.

Para utilização pela Internet, coloque o processo atrás de um reverse proxy com domínio e HTTPS e defina `APP_HTTPS=1`. O projeto inclui Dockerfile e Blueprint Render gratuito; o serviço só é publicado depois de configurar as contas e os segredos descritos em deploy/GRATUITO.md. A fotografia no telemóvel utiliza o seletor de câmara do dispositivo e funciona num navegador compatível. Para convidar outra pessoa, o URL tem de usar o domínio real acessível a ambos.

`APP_DATA_DIR` escolhe a pasta persistente; por defeito é `instance/` neste checkout. Deve ser um volume privado com espaço suficiente, fora das pastas públicas do servidor. A base de dados, os originais e a chave de sessão não entram no Git. Não execute vários processos ou réplicas nesta versão: um processo com quatro threads serve HTTP e mantém um trabalhador de OCR. O arranque recupera trabalhos interrompidos.

## Fluxos disponíveis

1. Carregue PDF/JPG/PNG, em lote ou pela câmara. Abra o documento e acompanhe a extração em segundo plano. Aplique as sugestões, confirme todos os campos e guarde a revisão. O original permanece intacto. PDFs com várias páginas são processados até ao limite de 100 páginas. Cada ficheiro tem limite de 20 MB.
2. Importe CSV, Excel `.xlsx`/`.xls` ou PDF. O original é guardado. Mapeie as colunas, corrija linhas, exclua movimentos e confirme a importação. PDFs são extraídos em segundo plano; se não for possível separar as linhas, pode introduzi-las manualmente. Reabra um extrato no arquivo para rever os movimentos depois da extração. Saídas são negativas e entradas positivas. Duplicados exigem confirmação.
3. Consulte as sugestões de correspondência e confirme o valor de cada associação. Uma fatura pode receber vários pagamentos e um movimento pode pagar várias faturas. O servidor bloqueia associações entre entidades e valores superiores aos saldos. Notas de crédito usam entradas para reembolsos. O upload nunca marca uma fatura como paga.
4. Crie um convite por email e escolha as entidades, os documentos específicos ou todos os financeiros, e a permissão de movimentos. Copie o link para o contabilista. Este precisa de se autenticar com o email convidado. Os convites expiram em 7 dias e são de utilização única. Pode alterar ou revogar o acesso imediatamente.
5. O contabilista consulta originais, comenta, pede esclarecimentos, altera o estado contabilístico e exporta ZIP por mês com originais e índices CSV, incluindo movimentos e associações quando autorizados. O administrador responde na plataforma. Os dados da obra associada não são enviados na resposta financeira.
6. Crie obras privadas, associe faturas na revisão e registe valores manuais sem comprovativo. Orçamento, adjudicado, faturado e pago são indicadores separados; os orçamentos não são somados às faturas. O faturado validado exclui documentos por rever e deduz notas de crédito. Registos manuais devem representar valores adicionais, e uma referência comum permite identificar despesas e adiantamentos correspondentes. Um recibo que apenas comprova uma fatura já registada deve usar a categoria **Comprovativo de pagamento** para não duplicar o custo.
7. Em Materiais, carregue dois orçamentos, reveja as linhas sugeridas ou registe manualmente os preços, ligando cada preço ao documento e página. Confirme a referência, marca, medidas, IVA e cobertura. Selecione os preços e compare €/m²; confirme equivalências quando necessário. Indique área e desperdício para calcular embalagens completas. Argamassas precisam de kg por embalagem, consumo documentado e espessura; nunca é inventada uma conversão. Os portes são repartidos pela quantidade registada; o custo real de uma nova encomenda deve ser reconfirmado.
8. Guarde contactos privados, várias especialidades editáveis, notas, avaliações, favoritos e associações a obras/documentos. Pesquise nome, localidade ou especialidade; use os botões de telefone, email e WhatsApp.

## Extração, serviços e custos

O OCR usa Tesseract local em português e inglês, texto PDF via pypdf/Poppler e leitura de QR com OpenCV. O modelo português vem do projeto oficial Tesseract, num commit fixo e com SHA-256 verificado. A extração por regras é conservadora: não infere dados ausentes, mede confiança de forma qualitativa e pede confirmação. As linhas sugeridas requerem colunas reconhecíveis; digitalizações irregulares podem precisar de introdução manual. Um QR fiscal legível tem prioridade, com aviso de divergência em relação ao texto.

A IA externa e o envio automático de email não estão configurados nesta instalação. A aplicação identifica essa situação e conserva os fluxos manuais. A comparação de materiais usa regras locais (referência, marca, medidas, cobertura e espessura), e produtos potencialmente equivalentes exigem confirmação. Os documentos são dados, não instruções executáveis. Nenhum texto de documento origina comandos ou ações de partilha.

OCR e armazenamento local não exigem um serviço externo nem cobram por documento. Os custos são os do servidor, volume de dados, domínio, HTTPS e cópias externas. Uma futura integração de IA terá custos de processamento do fornecedor escolhido e precisará de consentimento para enviar documentos; não foi efetuado nenhum envio externo nesta instalação. Convites são links copiados, sem custo de serviço de email.

## Segurança e separação

- Contas com hashes scrypt, sessões HTTP-only, proteção CSRF, limitação de tentativas e headers de segurança.
- Todas as rotas privadas exigem administrador. As consultas financeiras filtram entidades e documentos no servidor; a base de dados relaciona cada documento e movimento com uma entidade e associa os acessos explícitos. SQLite não tem políticas RLS: o controlo é realizado pela camada de acesso da aplicação. Não conceda acesso direto à base de dados ao contabilista.
- Os originais não são estáticos nem públicos. Ligações de descarga expiram em 5 minutos, exigem o mesmo utilizador autenticado e verificam novamente as permissões; revogar o acesso invalida também uma ligação já emitida.
- As permissões de contabilista não incluem apagar originais, editar dados validados ou consultar obras/materiais/contactos. Documentos privados nunca são incluídos mesmo com acesso a todos os financeiros.
- Validação de formato real, tamanho e páginas; documentos apagados ficam no arquivo recuperável. Os estados são auditados com autor, data e alteração. Índices CSV escapam fórmulas provenientes de dados importados.

Esta versão é destinada a uma instalação única de pequena dimensão. Não inclui faturação certificada, submissão à AT, ligação automática a bancos, contabilização oficial, múltiplos administradores, recuperação de palavra-passe por email nem restauro automático do arquivo JSON PostgreSQL. A classificação sugerida serve para organização e precisa de confirmação humana.

## Cópias e restauro

Em Definições, descarregue a cópia privada completa (SQLite ou arquivo JSON PostgreSQL, e todos os originais, inclusive apagados). O ZIP contém hashes de palavras-passe e dados privados: proteja-o e nunca o entregue ao contabilista.

```sh
bash scripts/backup.sh
```

A cópia consistente é criada em `instance/backups/`, ou `APP_DATA_DIR/backups/`. Pode agendar este comando diariamente no sistema de alojamento, por exemplo com cron; o projeto não instala um agendamento por si. Copie os ZIP para armazenamento cifrado fora do servidor e defina uma retenção. Exemplo de agendamento: `0 3 * * * cd /workspace/App-Contabilidade && bash scripts/backup.sh`.

Para restaurar: pare a aplicação, preserve a pasta atual, extraia **uma cópia de confiança** para uma nova pasta privada e configure `APP_DATA_DIR` para essa pasta. Deve conter `app.sqlite3` e `files/`; uma nova chave de sessão é criada e as sessões anteriores deixam de ser válidas. Verifique a integridade SQLite (`PRAGMA integrity_check`), os originais e a autenticação antes de substituir a instalação. Não restaure um ZIP recebido de terceiros.

## Verificação

```sh
.venv/bin/python -m pytest tests/test_app.py -q
.venv/bin/python -m pytest tests/test_browser.py -q
node --check app/static/app.js
```

Os testes usam dados explicitamente fictícios numa pasta temporária. Cobrem autenticação, CSRF, ficheiros, OCR real, QR fiscal, pagamentos parciais/repartidos, duplicados, entidades, revogação, exclusão recuperável, exportação e restauro. O teste Chromium percorre os fluxos pela interface, inclui conta separada de contabilista e verifica o layout de telemóvel. Os dados de teste não são inseridos na instalação real.

O código foi criado neste checkout. A execução local e a configuração guardada do ambiente não equivalem a publicação num domínio nem a envio do código para o GitHub.
