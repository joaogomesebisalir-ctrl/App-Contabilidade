"""Real browser end-to-end test; uses fictional data in a disposable database."""
import io, threading, os, uuid
import pytest
import psycopg
from playwright.sync_api import sync_playwright
from werkzeug.serving import make_server
from reportlab.pdfgen import canvas
from app import create_app


@pytest.mark.parametrize('backend',['sqlite','postgres'])
def test_browser_six_workflows_and_mobile(tmp_path,backend):
    config={'DATA_DIR':tmp_path,'TESTING':True}
    if backend=='postgres':
        if not os.environ.get('PG_TEST_URL'): pytest.skip('PG_TEST_URL required for PostgreSQL browser checks')
        config.update(DATABASE_URL=os.environ['PG_TEST_URL'],DB_SCHEMA='cc_browser_'+uuid.uuid4().hex[:12],SETUP_TOKEN='fictitious-browser-setup-code')
    app=create_app(config)
    server=make_server('127.0.0.1',0,app,threaded=True); thread=threading.Thread(target=server.serve_forever,daemon=True); thread.start()
    url=f'http://127.0.0.1:{server.server_port}'
    errors=[]
    try:
        with sync_playwright() as p:
            browser=p.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox'])
            page=browser.new_page(viewport={'width':1440,'height':1000})
            page.set_default_timeout(10000)
            page.on('pageerror',lambda e:errors.append(str(e)))
            page.goto(url)
            page.get_by_label('Nome',exact=True).fill('Demonstração automatizada')
            page.get_by_label('Email',exact=True).fill('admin@example.test')
            page.get_by_label('Palavra-passe',exact=True).fill('uma-palavra-passe-segura-123')
            if backend=='postgres': page.get_by_label('Código de instalação',exact=True).fill(config['SETUP_TOKEN'])
            page.get_by_role('button',name='Criar o meu espaço').click()
            page.get_by_role('button',name='Definições',exact=False).click()
            page.get_by_role('button',name='Nova entidade').click()
            page.get_by_label('Nome',exact=True).fill('Entidade fictícia de teste')
            page.get_by_label('NIF',exact=True).fill('123456789')
            page.get_by_role('button',name='Criar entidade').click()
            page.get_by_role('button',name='Documentos',exact=True).click()
            pdf=io.BytesIO(); c=canvas.Canvas(pdf)
            for i,t in enumerate(['Fatura FT 2026/1','Fornecedor: Materiais Exemplo','NIF fornecedor: 501234567','Data: 09/10/2026','Subtotal: 100,00','Total IVA: 23,00','Total: 123,00']): c.drawString(40,780-i*22,t)
            c.save()
            page.locator('#files').set_input_files({'name':'fatura-ficticia.pdf','mimeType':'application/pdf','buffer':pdf.getvalue()})
            page.get_by_role('button',name='Abrir',exact=True).click()
            page.get_by_role('button',name='Atualizar extração',exact=True).click()
            for _ in range(30):
                if page.locator('#modal').get_by_text('Extração concluída',exact=True).count(): break
                page.wait_for_timeout(300); page.get_by_role('button',name='Atualizar extração',exact=True).click()
            page.on('dialog',lambda d:d.accept())
            page.get_by_role('button',name='Aplicar sugestões para revisão').click()
            page.get_by_label('Tipo',exact=True).select_option('Fatura')
            page.get_by_label('Revisão',exact=True).select_option('validado')
            page.get_by_role('button',name='Guardar revisão').click()
            page.locator('#toast').get_by_text('Documento guardado.',exact=True).wait_for()
            page.get_by_role('button',name='×',exact=True).click()
            page.get_by_role('button',name='Movimentos bancários',exact=False).click()
            page.get_by_role('button',name='Importar extrato',exact=False).click()
            page.get_by_label('Entidade',exact=True).select_option(index=1)
            page.get_by_label('Banco',exact=True).fill('Banco fictício')
            page.get_by_label('Conta / IBAN',exact=True).fill('Conta de teste')
            page.locator('input[name=file]').set_input_files({'name':'extrato.csv','mimeType':'text/csv','buffer':b'Data;Descricao;Montante\n10/10/2026;Materiais Exemplo FT 2026/1;-123,00\n'})
            page.get_by_role('button',name='Ler e mapear colunas').click()
            page.get_by_role('button',name='Confirmar e importar').click()
            page.get_by_role('button',name='Associar',exact=True).click()
            page.get_by_label('Documento',exact=True).select_option(index=1)
            page.get_by_role('button',name='Confirmar associação').click()
            page.get_by_text('Associações confirmadas',exact=True).wait_for()
            # Accountant invite and auth with a separate browser cookie jar.
            page.get_by_role('button',name='Área do contabilista',exact=False).click()
            page.get_by_role('button',name='Convidar contabilista',exact=False).click()
            page.get_by_label('Email do contabilista').fill('contas@example.test')
            page.locator('[name=scope_entity]').check(); page.locator('.scope-all').check(); page.locator('.scope-bank').check()
            page.get_by_role('button',name='Criar link de convite').click()
            invite=page.locator('#invite-url').input_value()
            account=browser.new_context(); accountant=account.new_page(); accountant.goto(invite)
            accountant.get_by_role('button',name='Criar conta com convite').click()
            accountant.get_by_label('Nome',exact=True).fill('Contabilista fictício')
            accountant.get_by_label('Email',exact=True).fill('contas@example.test')
            accountant.get_by_label('Palavra-passe',exact=True).fill('uma-palavra-passe-segura-123')
            accountant.get_by_role('button',name='Criar conta e aceitar').click()
            accountant.get_by_role('button',name='Documentos',exact=True).click()
            accountant.locator('[data-action=document][data-id="1"]').first.click()
            accountant.get_by_role('link',name='Descarregar original').wait_for()
            assert accountant.get_by_role('button',name='Obras',exact=False).count()==0
            assert account.request.get(url+'/api/private/works').status==403
            accountant.get_by_label('Comentário').fill('Documento confirmado em teste.')
            accountant.get_by_role('button',name='Enviar comentário').click()
            accountant.get_by_text('Documento confirmado em teste.',exact=True).wait_for()
            page.get_by_role('button',name='×',exact=True).click()
            page.get_by_role('button',name='Obras',exact=False).click()
            page.get_by_role('button',name='Nova obra',exact=False).click()
            page.get_by_label('Nome da obra').fill('Obra fictícia')
            page.get_by_label('Orçamento previsto com IVA').fill('1000')
            page.get_by_role('button',name='Guardar',exact=True).click()
            page.get_by_role('button',name='Abrir obra').click()
            page.get_by_role('button',name='Registar valor manual',exact=False).click()
            page.get_by_label('Descrição',exact=True).fill('Adiantamento fictício')
            page.get_by_label('Tipo de valor').select_option('pago')
            page.get_by_label('Montante com IVA').fill('20')
            page.get_by_role('button',name='Guardar',exact=True).click()
            # Two historical prices with coverage, linked to original documents.
            page.get_by_role('button',name='Materiais',exact=True).click()
            for index,(supplier,price) in enumerate([('Fornecedor A',24),('Fornecedor B',30)],3):
                quote=io.BytesIO(); q=canvas.Canvas(quote); q.drawString(40,780,f'Orcamento ficticio {supplier}'); q.drawString(40,750,f'Pavimento ficticio;2;caixa;{price},00'); q.save()
                page.locator('#files').set_input_files({'name':f'orcamento-ficticio-{index}.pdf','mimeType':'application/pdf','buffer':quote.getvalue()})
                page.locator(f'[data-action=source-lines][data-id="{index}"]').click()
                for _ in range(40):
                    if page.locator('#modal [data-action=source-line]').count(): break
                    page.wait_for_timeout(250); page.locator('#modal [data-action=source-lines]').click()
                page.get_by_role('button',name='Rever e registar').click()
                page.get_by_label('Nome do material').fill('Pavimento fictício')
                page.get_by_label('Fornecedor',exact=True).fill(supplier)
                page.get_by_label('Marca',exact=True).fill('Exemplo')
                page.get_by_label('Referência',exact=True).fill('PV-01')
                page.get_by_label('Preço por embalagem / unidade sem IVA').fill(str(price))
                page.get_by_label('IVA (%) — vazio se desconhecido').fill('23')
                page.get_by_label('Cobertura por embalagem').fill('2')
                assert page.get_by_label('Documento de origem').input_value()==str(index)
                page.get_by_role('button',name='Guardar',exact=True).click()
                page.locator('#modal').wait_for(state='hidden')
            page.locator('[data-material-id]').nth(0).check(); page.locator('[data-material-id]').nth(1).check()
            page.get_by_role('button',name='Comparar selecionados').click()
            page.get_by_label('Área necessária').fill('10')
            page.get_by_role('button',name='Calcular comparação').click()
            page.get_by_text('Mais económico c/ IVA',exact=True).wait_for()
            assert page.get_by_text('6 embalagem(ns) / unidade(s) completas',exact=True).count()==2
            page.get_by_role('button',name='×',exact=True).click()
            page.get_by_role('button',name='Contactos',exact=False).click()
            page.get_by_role('button',name='Novo contacto',exact=False).click()
            page.get_by_label('Nome',exact=True).fill('Profissional fictício')
            page.get_by_label('Especialidades editáveis').fill('Eletricista\nCanalizador')
            page.get_by_role('button',name='Guardar',exact=True).click()
            page.locator('#modal').wait_for(state='hidden')
            page.locator('#private-category').fill('Eletricista')
            page.get_by_role('heading',name='Profissional fictício').wait_for()
            page.set_viewport_size({'width':390,'height':844})
            page.get_by_role('button',name='☰',exact=True).click()
            page.get_by_role('button',name='Painel geral',exact=False).click()
            page.get_by_role('heading',name='Despesas por mês').wait_for()
            assert page.evaluate('() => document.documentElement.scrollWidth <= window.innerWidth')
            page.wait_for_timeout(300)  # Let the mobile navigation transition finish.
            page.screenshot(path=str(tmp_path/'mobile.png'),full_page=True)
            page.set_viewport_size({'width':1440,'height':1000})
            page.screenshot(path=str(tmp_path/'desktop.png'),full_page=True)
            assert errors==[],errors
            browser.close()
    finally:
        app.extensions['ocr_stop'].set()
        server.shutdown()

        if backend=='postgres':
            from psycopg import sql
            with psycopg.connect(config['DATABASE_URL']) as con:
                con.execute(sql.SQL('DROP SCHEMA {} CASCADE').format(sql.Identifier(config['DB_SCHEMA'])))
