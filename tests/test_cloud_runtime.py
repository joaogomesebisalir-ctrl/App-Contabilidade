"""Cloud API and real browser codecs against disposable PostgreSQL and Storage."""
import io,json,os,select,subprocess,zipfile
import pytest
from PIL import Image,ImageDraw,ImageFont
from playwright.sync_api import sync_playwright

@pytest.fixture
def cloud_url():
    if not os.environ.get('PG_TEST_URL'): pytest.skip('Disposable PG_TEST_URL required')
    process=subprocess.Popen(['node','cloud/scripts/test-server.mjs'],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
    try:
        assert select.select([process.stdout],[],[],30)[0]
        line=process.stdout.readline();assert line,process.stderr.read()
        yield json.loads(line)['url']
    finally:
        process.terminate();process.wait(timeout=15)


def test_cloud_ocr_backup_and_csrf(cloud_url,tmp_path):
    with sync_playwright() as p:
        browser=p.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox'])
        page=browser.new_page();page.goto(cloud_url)
        session=page.request.get(cloud_url+'/api/session').json()
        assert page.request.post(cloud_url+'/api/setup',data={}).status==403
        headers={'X-CSRF-Token':session['csrf']}
        assert page.request.post(cloud_url+'/api/setup',headers=headers,data={'email':'admin@example.test','name':'Test','password':'fictitious-password-123','setup_token':'fictitious-edge-setup-code'}).status==200
        session=page.request.get(cloud_url+'/api/session').json();headers={'X-CSRF-Token':session['csrf']}
        entity=page.request.post(cloud_url+'/api/entities',headers=headers,data={'name':'Test','nif':'123456789','kind':'empresa'}).json()['id']
        image=Image.new('RGB',(1400,800),'white');draw=ImageDraw.Draw(image)
        font=ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',40)
        for i,text in enumerate(['Fatura FT 2026/99','Fornecedor: Exemplo','Data: 09/10/2026','Subtotal: 100,00','Total IVA: 23,00','Total: 123,00']):draw.text((40,40+i*85),text,font=font,fill='black')
        buf=io.BytesIO();image.save(buf,format='PNG');raw=buf.getvalue()
        uploaded=page.request.post(cloud_url+'/api/documents',headers=headers,multipart={'entity_id':str(entity),'file':{'name':'ficticia.png','mimeType':'image/png','buffer':raw}})
        assert uploaded.status==201,uploaded.text();doc_id=uploaded.json()['document']['id']
        page.reload();page.wait_for_function('!!window.ContaCloud')
        page.wait_for_timeout(300)
        # Resume automatically invokes actual self-hosted Tesseract WASM in the browser.
        for _ in range(180):
            doc=page.request.get(f'{cloud_url}/api/documents/{doc_id}').json()
            if doc['ocr_status'] in ('completed','error'):break
            page.wait_for_timeout(500)
        assert doc['ocr_status']=='completed',doc.get('ocr_error')
        assert '123' in doc['extraction']['text']
        assert doc['extraction']['fields']['total']==123
        # A scanned multi-page PDF exercises OffscreenCanvas and actual OCR/QR.
        from reportlab.pdfgen import canvas
        from reportlab.lib.utils import ImageReader
        import cv2
        from PIL import ImageOps
        pdf=io.BytesIO();writer=canvas.Canvas(pdf)
        writer.drawImage(ImageReader(image),30,250,width=535,height=305);writer.showPage()
        fiscal='A:501234567*B:123456789*D:FT*F:20261009*G:FT2026/99*N:46.00*O:246.00'
        qr=ImageOps.expand(Image.fromarray(cv2.QRCodeEncoder_create().encode(fiscal)),border=4,fill=255).resize((900,900),Image.Resampling.NEAREST).convert('RGB')
        writer.drawImage(ImageReader(qr),80,200,width=430,height=430);writer.save()
        response=page.request.post(cloud_url+'/api/documents',headers=headers,multipart={'entity_id':str(entity),'file':{'name':'scanned.pdf','mimeType':'application/pdf','buffer':pdf.getvalue()}})
        assert response.status==201,response.text()
        pdf_id=response.json()['document']['id']
        page.evaluate('(id)=>window.ContaCloud.process(id)',pdf_id)
        extracted=page.request.get(f'{cloud_url}/api/documents/{pdf_id}').json()
        assert extracted['ocr_status']=='completed',extracted.get('ocr_error')
        assert extracted['extraction']['pages']==2
        assert extracted['extraction']['fields']['total']==246
        assert extracted['extraction']['warnings']
        assert '123' in extracted['extraction']['text']
        # Excel codec is self-hosted and preserves dates and decimal amounts.
        import openpyxl,base64
        workbook=openpyxl.Workbook();sheet=workbook.active
        sheet.append(['Data','Descricao','Montante']);sheet.append(['09/10/2026','Exemplo',-123.45])
        excel=io.BytesIO();workbook.save(excel)
        preview=page.evaluate("async b64=>window.ContaCloud.preview(new File([Uint8Array.from(atob(b64),c=>c.charCodeAt(0))],'extrato.xlsx'))",base64.b64encode(excel.getvalue()).decode())
        assert preview['rows']==[{'Data':'09/10/2026','Descricao':'Exemplo','Montante':-123.45}]
        snapshot=page.request.get(cloud_url+'/api/backup')
        assert snapshot.status==200
        assert snapshot.headers['x-conta-archive']=='snapshot'
        assert len(snapshot.json()['tables']['documents'])==2
        assert page.request.delete(f'{cloud_url}/api/documents/{doc_id}',headers=headers).status==200
        # Deleted originals remain in the private administrative backup.
        with page.expect_download(timeout=30000) as download:
            page.evaluate("window.ContaCloud.archive('/api/backup')")
        path=tmp_path/'backup.zip';download.value.save_as(path)
        with zipfile.ZipFile(path) as archive:
            data=json.loads(archive.read('dados.json'))
            assert next(d for d in data['tables']['documents'] if d['id']==doc_id)['deleted']
            originals=[n for n in archive.namelist() if n.startswith('files/')]
            assert len(originals)==2
            assert raw in [archive.read(name) for name in originals]
        stale=headers.copy()
        assert page.request.post(cloud_url+'/api/logout',headers=headers).status==200
        assert page.request.get(cloud_url+'/api/backup').status==401
        assert page.request.post(cloud_url+'/api/entities',headers=stale,data={'name':'Bad'}).status==403
        session=page.request.get(cloud_url+'/api/session').json()
        headers={'X-CSRF-Token':session['csrf']}
        for _ in range(8):
            assert page.request.post(cloud_url+'/api/login',headers=headers,data={'email':'admin@example.test','password':'wrong-password'}).status==401
        assert page.request.post(cloud_url+'/api/login',headers=headers,data={'email':'admin@example.test','password':'wrong-password'}).status==429
        browser.close()


def test_cloud_database_permissions_and_concurrent_payments(cloud_url):
    import psycopg
    from concurrent.futures import ThreadPoolExecutor
    with sync_playwright() as p:
        request=p.request.new_context(base_url=cloud_url)
        session=request.get('/api/session').json()
        response=request.post('/api/setup',headers={'X-CSRF-Token':session['csrf']},data={'email':'admin@example.test','name':'Test','password':'fictitious-password-123','setup_token':'fictitious-edge-setup-code'})
        assert response.status==200
        stats=request.get('/_test/stats').json();schema=stats['schema']
    def query(sql,params=()):
        with psycopg.connect(os.environ['PG_TEST_URL']) as db:
            return db.execute('SELECT public.cc_query(%s,%s::jsonb)',(sql,json.dumps(params))).fetchone()[0]
    attack="x'); DELETE FROM users; --"
    assert query('SELECT ?::text AS value',[attack])['rows'][0]['value']==attack
    with psycopg.connect(os.environ['PG_TEST_URL']) as db:
        db.execute('SET ROLE anon')
        with pytest.raises(psycopg.errors.InsufficientPrivilege):db.execute("SELECT public.cc_snapshot()")
    eid=query("INSERT INTO entities(name,nif,kind) VALUES(?,?,?) RETURNING id",['Test','123456789','empresa'])['id']
    did=query("INSERT INTO documents(entity_id,filename,storage,mime,sha256,created,metadata) VALUES(?,?,?,?,?,?,?) RETURNING id",[eid,'test.pdf','test-storage.pdf','application/pdf','fictitious','2026-10-09',json.dumps({'type':'Fatura','total':100})])['id']
    mid=query("INSERT INTO movements(entity_id,bank,account,date,description,amount,fingerprint,created) VALUES(?,?,?,?,?,?,?,?) RETURNING id",[eid,'Test','Test','2026-10-09','Test',-10000,'test','2026-10-09'])['id']
    def allocate():
        try:
            query('INSERT INTO allocations(movement_id,document_id,amount,created,user_id) VALUES(?,?,?,?,?) RETURNING id',[mid,did,7000,'2026-10-09',1]);return 'accepted'
        except psycopg.errors.RaiseException:return 'rejected'
    with ThreadPoolExecutor(max_workers=2) as executor:
        assert sorted(executor.map(lambda _:allocate(),range(2)))==['accepted','rejected']
    assert query('SELECT sum(amount) AS total FROM allocations')['rows'][0]['total']==7000
    with pytest.raises(psycopg.errors.RaiseException):query('UPDATE documents SET metadata=? WHERE id=?',[json.dumps({'type':'Fatura','total':60}),did])
    assert query('SELECT metadata FROM documents WHERE id=?',[did])['rows'][0]['metadata']==json.dumps({'type':'Fatura','total':100})

    # Duplicate confirmation remains atomic when two uploads race.
    sql='INSERT INTO documents(entity_id,filename,storage,mime,sha256,created) VALUES(?,?,?,?,?,?) RETURNING id'
    def duplicate_upload(index):
        with psycopg.connect(os.environ['PG_TEST_URL']) as db:
            params=[eid,'duplicate.pdf',f'concurrent-{index}.pdf','application/pdf','same-content-sha','2026-10-09']
            audit={'user_id':1,'action':'uploaded','resource':'documents','resource_id':'$last','detail':json.dumps({'confirm_duplicate':False})}
            try:
                db.execute('SELECT public.cc_query(%s,%s::jsonb,%s::jsonb)',(sql,json.dumps(params),json.dumps(audit))).fetchone();return 'accepted'
            except psycopg.errors.UniqueViolation:return 'rejected'
    with ThreadPoolExecutor(max_workers=2) as executor:
        assert sorted(executor.map(duplicate_upload,range(2)))==['accepted','rejected']
    # Blank unknown totals are valid on an unreviewed document.
    query('UPDATE documents SET metadata=? WHERE sha256=?',[json.dumps({'total':''}),'same-content-sha'])
