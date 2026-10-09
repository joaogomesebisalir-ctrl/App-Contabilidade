import io, json, sqlite3, zipfile
from pathlib import Path
import pytest
from PIL import Image, ImageDraw, ImageFont
from reportlab.pdfgen import canvas
from app import create_app
from app.processing import extract, qr_fields

PASS='uma-palavra-passe-segura-123'
class Client:
    def __init__(self,app):
        self.client=app.test_client(); self.csrf=self.get('/api/session').json['csrf']
    def get(self,url): return self.client.get(url)
    def call(self,method,url,d=None,**kw):
        r=self.client.open(url,method=method,json=d,headers={'X-CSRF-Token':self.csrf},**kw)
        if r.is_json and r.json.get('csrf'): self.csrf=r.json['csrf']
        return r
    def post(self,url,d=None): return self.call('POST',url,d)
    def login(self,email='admin@example.test'):
        r=self.post('/api/login',{'email':email,'password':PASS}); assert r.status_code==200,r.json
    def upload(self,eid,raw=None,name='fatura.pdf',private=False,duplicate=False):
        raw=raw or pdf()
        return self.client.post('/api/documents',data={'entity_id':str(eid),'visibility':'private' if private else 'financial','confirm_duplicate':str(duplicate).lower(),'file':(io.BytesIO(raw),name)},headers={'X-CSRF-Token':self.csrf},content_type='multipart/form-data')

def pdf(text=None):
    stream=io.BytesIO(); c=canvas.Canvas(stream)
    for i,line in enumerate(text or ['Fatura FT 2026/1','Fornecedor: Materiais Exemplo','NIF fornecedor: 501234567','Data: 09/10/2026','Subtotal: 100,00','Total IVA: 23,00','Total: 123,00','Pavimento;2;caixa;20,00']): c.drawString(40,780-i*22,line)
    c.save(); return stream.getvalue()

@pytest.fixture
def env(tmp_path):
    app=create_app({'TESTING':True,'START_WORKER':False,'DATA_DIR':tmp_path}); admin=Client(app)
    r=admin.post('/api/setup',{'email':'admin@example.test','name':'Administrador de teste','password':PASS}); assert r.status_code==200
    entities=[]
    for name,nif in [('Pessoal','123456789'),('Empresa','501234567')]:
        r=admin.post('/api/entities',{'name':name,'nif':nif,'kind':'pessoal'}); assert r.status_code==201; entities.append(r.json['id'])
    return app,admin,entities,tmp_path

def invoice(admin,eid,total=123,private=False,number='FT 2026/1',work=None):
    r=admin.upload(eid,private=private); assert r.status_code==201,r.json
    did=r.json['document']['id']; r=admin.call('PUT',f'/api/documents/{did}',{'metadata':{'type':'Fatura','supplier':'Materiais Exemplo','supplier_nif':'501234567','number':number,'date':'09/10/2026','total':total,'net':100,'vat':23},'review':'validado','work_id':work}); assert r.status_code==200,r.json
    return did

def accountant(app,admin,eid,ids=None,all_docs=False,bank=False,email='contas@example.test'):
    r=admin.post('/api/invitations',{'email':email,'scope':[{'entity_id':eid,'all_documents':all_docs,'bank_access':bank,'document_ids':ids or []}]}); assert r.status_code==201,r.json
    token=r.json['path'].split('invite=')[1]; acc=Client(app)
    r=acc.post('/api/register-invite',{'token':token,'email':email,'name':'Contabilista','password':PASS}); assert r.status_code==200,r.json
    r=acc.post('/api/invitations/accept',{'token':token}); assert r.status_code==200,r.json
    return acc,token

def bank(admin,eid,amount=-123,description='Materiais Exemplo FT 2026/1'):
    r=admin.post('/api/bank/import',{'entity_id':eid,'bank':'Banco fictício','account':'Conta fictícia','rows':[{'date':'10/10/2026','description':description,'amount':amount}]}); assert r.status_code==201,r.json
    return admin.get('/api/movements').json[0]['id']

def test_full_financial_workflow_and_export(env):
    app,admin,(eid,_),root=env; did=invoice(admin,eid); mid=bank(admin,eid)
    assert admin.get(f'/api/movements/{mid}/suggestions').json[0]['document']['id']==did
    for amount in (50,73): assert admin.post('/api/allocations',{'movement_id':mid,'document_id':did,'amount':amount}).status_code==201
    assert admin.get(f'/api/documents/{did}').json['payment']=='pago'
    acc,_=accountant(app,admin,eid,[did],bank=True)
    assert acc.post(f'/api/documents/{did}/comments',{'body':'Confirmado pelo contabilista.'}).status_code==201
    assert acc.post(f'/api/documents/{did}/accounting',{'state':'tratado'}).status_code==200
    req=acc.post('/api/requests',{'entity_id':eid,'document_id':did,'body':'Falta o comprovativo.'}).json['id']
    assert admin.post(f'/api/requests/{req}/reply',{'body':'Associado acima.','resolved':True}).status_code==200
    assert acc.get('/api/requests').json[0]['status']=='resolved'
    link=acc.get(f'/api/documents/{did}/link').json['url']; assert acc.get(link).data.startswith(b'%PDF')
    out=acc.get(f'/api/export?entity_id={eid}&period=2026-10'); assert out.status_code==200
    with zipfile.ZipFile(io.BytesIO(out.data)) as z:
        assert 'indice.csv' in z.namelist() and 'movimentos.csv' in z.namelist() and 'associacoes.csv' in z.namelist()
        assert len([p for p in z.namelist() if p.startswith('originais/')])==1
        assert 'FT 2026/1' in z.read('indice.csv').decode('utf-8-sig')
    assert len(acc.get('/api/allocations').json)==2

def test_permission_boundaries_and_revocation(env):
    app,admin,(eid,other),root=env; did=invoice(admin,eid); private=invoice(admin,eid,private=True,number='PR/1'); foreign=invoice(admin,other,number='FT/2')
    acc,token=accountant(app,admin,eid,[did],bank=False)
    assert [d['id'] for d in acc.get('/api/documents').json]==[did]
    assert acc.get(f'/api/documents/{private}').status_code==403
    assert acc.get(f'/api/documents/{foreign}').status_code==403
    assert acc.get('/api/movements').json==[]
    for kind in ('works','materials','contacts','expenses'):
        for method,path in [('GET',f'/api/private/{kind}'),('POST',f'/api/private/{kind}'),('GET',f'/api/private/{kind}/1'),('PUT',f'/api/private/{kind}/1'),('DELETE',f'/api/private/{kind}/1')]:
            assert acc.call(method,path,{'name':'Ataque'} if method in ('POST','PUT') else None).status_code==403
    assert acc.call('DELETE',f'/api/documents/{did}').status_code==403
    assert acc.call('PUT',f'/api/documents/{did}',{'metadata':{}}).status_code==403
    for path in ['/api/backup','/api/audit','/api/access']: assert acc.get(path).status_code==403
    link=acc.get(f'/api/documents/{did}/link').json['url']
    assert admin.get(link).status_code==403
    acc_id=acc.get('/api/session').json['user']['id']
    assert admin.call('PUT',f'/api/access/{acc_id}',{'scope':[]}).status_code==200
    assert acc.get(link).status_code==403
    assert acc.get('/api/documents').json==[]
    assert acc.get('/api/entities').json==[]
    assert acc.post('/api/invitations/accept',{'token':token}).status_code==400

def test_all_financial_grant_never_includes_private_or_work_data(env):
    app,admin,(eid,_),root=env
    wid=admin.post('/api/private/works',{'name':'Obra privada','notes':'SEGREDO','budget':1000}).json['id']
    did=invoice(admin,eid,work=wid); private=invoice(admin,eid,private=True,number='PR2')
    acc,_=accountant(app,admin,eid,all_docs=True)
    assert [d['id'] for d in acc.get('/api/documents').json]==[did]
    out=acc.get(f'/api/documents/{did}').json; assert 'work_id' not in out
    dash=acc.get('/api/dashboard').json; assert 'works' not in dash and 'latest_materials' not in dash
    with zipfile.ZipFile(io.BytesIO(acc.get(f'/api/export?entity_id={eid}&period=2026-10').data)) as z:
        assert all('SEGREDO' not in z.read(n).decode('utf-8',errors='ignore') for n in z.namelist())

def test_duplicates_and_entity_separation(env):
    app,admin,(eid,other),root=env
    raw=pdf(); first=admin.upload(eid,raw); assert first.status_code==201
    assert admin.upload(eid,raw).status_code==409
    assert admin.upload(eid,raw,duplicate=True).status_code==201
    did=invoice(admin,eid); foreign=invoice(admin,other,number='FT/other'); mid=bank(admin,eid)
    assert admin.post('/api/allocations',{'movement_id':mid,'document_id':foreign,'amount':1}).status_code==400
    assert admin.post('/api/allocations',{'movement_id':mid,'document_id':did,'amount':124}).status_code==400
    repeated=admin.post('/api/bank/import',{'entity_id':eid,'bank':'Banco fictício','account':'Conta fictícia','rows':[{'date':'10/10/2026','description':'Materiais Exemplo FT 2026/1','amount':-123}]}); assert repeated.status_code==409

def test_one_payment_multiple_invoices_and_partial(env):
    app,admin,(eid,_),root=env; first=invoice(admin,eid,total=100,number='FT/1'); second=invoice(admin,eid,total=100,number='FT/2'); mid=bank(admin,eid,-150)
    assert admin.post('/api/allocations',{'movement_id':mid,'document_id':first,'amount':100}).status_code==201
    assert admin.post('/api/allocations',{'movement_id':mid,'document_id':second,'amount':50}).status_code==201
    assert admin.get(f'/api/documents/{first}').json['payment']=='pago'
    assert admin.get(f'/api/documents/{second}').json['payment']=='parcialmente_pago'
    assert admin.post('/api/allocations',{'movement_id':mid,'document_id':second,'amount':1}).status_code==400
    nextmid=bank(admin,eid,-50,'Segundo pagamento')
    assert admin.post('/api/allocations',{'movement_id':nextmid,'document_id':second,'amount':50}).status_code==201
    assert admin.get(f'/api/documents/{second}').json['payment']=='pago'

def test_soft_delete_and_original_restoration(env):
    app,admin,(eid,_),root=env; did=invoice(admin,eid); acc,_=accountant(app,admin,eid,all_docs=True)
    link=acc.get(f'/api/documents/{did}/link').json['url']
    assert admin.call('DELETE',f'/api/documents/{did}').status_code==200
    assert acc.get(link).status_code in (403,404)
    assert admin.get('/api/documents').json==[]
    assert admin.get('/api/documents?deleted=1').json[0]['deleted']
    assert admin.post(f'/api/documents/{did}/restore',{}).status_code==200
    assert acc.get(link).status_code==200

def test_csrf_auth_and_file_validation(env):
    app,admin,(eid,_),root=env; anon=Client(app)
    assert anon.get('/api/documents').status_code==401
    assert admin.client.post('/api/entities',json={'name':'Ataque'}).status_code==403
    assert admin.upload(eid,b'<script>alert(1)</script>','attack.pdf').status_code==400
    assert admin.upload(eid,b'<html>','attack.png').status_code==400
    assert anon.get('/instance/app.sqlite3').status_code==404
    assert anon.get('/api/backup').status_code==401
    assert admin.post('/api/setup',{'email':'other@example.test','name':'Other','password':PASS}).status_code==409

def test_works_do_not_double_count_commitments(env):
    app,admin,(eid,_),root=env; wid=admin.post('/api/private/works',{'name':'Obra teste','budget':1000,'categories':['Pavimento']}).json['id']
    for typ,amount in [('adjudicado',500),('faturado',50),('pago',20)]: assert admin.post('/api/private/expenses',{'name':'Manual '+typ,'work_id':wid,'type':typ,'amount':amount,'date':'09/10/2026'}).status_code==201
    did=invoice(admin,eid,total=123,work=wid); mid=bank(admin,eid); admin.post('/api/allocations',{'movement_id':mid,'document_id':did,'amount':123})
    summary=admin.get('/api/private/works').json[0]['summary']; assert summary['awarded']==50000; assert summary['invoiced']==17300; assert summary['paid']==14300; assert summary['unpaid']==3000
    assert admin.post('/api/private/expenses',{'name':'Duplicado','work_id':wid,'type':'faturado','amount':123,'document_id':did,'date':'09/10/2026'}).status_code==400
    assert admin.call('DELETE',f'/api/private/works/{wid}').status_code==400

def test_material_comparison_and_rounding(env):
    app,admin,(eid,_),root=env; ids=[]
    for supplier,price in [('Fornecedor A',24),('Fornecedor B',30)]:
        r=admin.post('/api/private/materials',{'name':'Pavimento','supplier':supplier,'brand':'Exemplo','reference':'PV-01','category':'Pavimentos','unit':'caixa','coverage':2,'quantity':10,'price':price,'vat':23,'shipping':10,'date':'09/10/2026'}); assert r.status_code==201,r.json; ids.append(r.json['id'])
    r=admin.post('/api/materials/compare',{'ids':ids,'area':10,'waste':10}); assert r.status_code==200
    assert r.json['best_id']==ids[0]; first=r.json['items'][0]; assert first['price']['unit_net']==12; assert first['needs']['packs']==6; assert first['needs']['total_gross']==177.12
    assert r.json['items'][1]['difference_percent']==25
    missing=admin.post('/api/private/materials',{'name':'Argamassa','price':10,'unit':'saco','vat':23,'reference':'ARG'}).json['id']
    record=next(m for m in admin.get('/api/private/materials').json if m['id']==missing); assert record['price_summary']['unit_net'] is None
    assert admin.post('/api/materials/compare',{'ids':[ids[0],missing]}).json['best_id'] is None

def test_contacts_and_persistence_backup(env):
    app,admin,_,root=env
    r=admin.post('/api/private/contacts',{'name':'Profissional fictício','specialties':['Eletricista','Canalizador'],'notes':'Nota privada','favorite':True}); assert r.status_code==201
    ident=r.json['id']; new_app=create_app({'TESTING':True,'START_WORKER':False,'DATA_DIR':root}); c=Client(new_app); c.login()
    assert c.get(f'/api/private/contacts/{ident}').json['data']['notes']=='Nota privada'
    response=c.get('/api/backup'); assert response.status_code==200
    with zipfile.ZipFile(io.BytesIO(response.data)) as z:
        assert 'app.sqlite3' in z.namelist(); dbpath=root/'restored.sqlite3'; dbpath.write_bytes(z.read('app.sqlite3')); con=sqlite3.connect(dbpath); assert con.execute("SELECT count(*) FROM private_records WHERE kind='contacts'").fetchone()[0]==1; con.close()

def test_csv_and_excel_preview(env):
    app,admin,(eid,_),root=env
    for ext,content in [('csv',b'Data;Descricao;Montante\n09/10/2026;Pagamento;-123,00\n')]:
        r=admin.client.post('/api/bank/preview',data={'entity_id':str(eid),'file':(io.BytesIO(content),'bank.'+ext)},headers={'X-CSRF-Token':admin.csrf}); assert r.status_code==200; assert r.json['rows'][0]['Montante']=='-123,00'
    from openpyxl import Workbook
    wb=Workbook(); ws=wb.active; ws.append(['Data','Descricao','Montante']); ws.append(['09/10/2026','Pagamento',-123]); out=io.BytesIO(); wb.save(out)
    r=admin.client.post('/api/bank/preview',data={'entity_id':str(eid),'file':(io.BytesIO(out.getvalue()),'bank.xlsx')},headers={'X-CSRF-Token':admin.csrf}); assert r.status_code==200; assert r.json['rows'][0]['Montante']==-123

def test_ocr_real_pdf_and_fiscal_qr(tmp_path):
    path=tmp_path/'fatura.pdf'; path.write_bytes(pdf()); result=extract(path,'application/pdf')
    assert result['fields']['total']==123; assert result['fields']['date']=='2026-10-09'; assert result['lines'][0]['price']==20; assert result['pages']==1
    qr=qr_fields('A:501234567*B:123456789*C:PT*D:FT*F:20261009*G:FT 2026/1*N:23.00*O:123.00*I1:PT*I7:100.00*I8:23.00')
    assert qr['total']==123 and qr['supplier_nif']=='501234567' and qr['net']==100

def test_ocr_scanned_image(tmp_path):
    image=Image.new('RGB',(1600,500),'white'); draw=ImageDraw.Draw(image); font=ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',42)
    draw.text((60,70),'Total: 123,00 EUR',font=font,fill='black'); draw.text((60,150),'Data: 09/10/2026',font=font,fill='black'); path=tmp_path/'photo.png'; image.save(path)
    result=extract(path,'image/png'); assert result['fields']['total']==123; assert result['fields']['date']=='2026-10-09'

def test_pdf_bank_preview_is_background_and_preserves_origin(env):
    app,admin,(eid,_),root=env
    raw=pdf(['Extrato ficticio','09/10/2026;Pagamento ficticio;-123,00;500,00'])
    r=admin.client.post('/api/bank/preview',data={'entity_id':str(eid),'file':(io.BytesIO(raw),'extrato.pdf')},headers={'X-CSRF-Token':admin.csrf})
    assert r.status_code==200 and r.json['pending']; did=r.json['source_id']
    assert admin.get(f'/api/bank/preview/{did}').json['pending']
    doc=admin.get(f'/api/documents/{did}').json
    result=extract(root/'files'/next((root/'files').iterdir()).name,'application/pdf')
    conn=sqlite3.connect(root/'app.sqlite3'); conn.execute("UPDATE documents SET extraction=?,ocr_status='completed' WHERE id=?",(json.dumps(result),did)); conn.commit(); conn.close()
    reviewed=admin.get(f'/api/bank/preview/{did}').json
    assert not reviewed['pending'] and reviewed['rows'][0]['Coluna 3']=='-123,00'
    assert admin.get(admin.get(f'/api/documents/{did}/link').json['url']).data==raw


def test_multiple_page_pdf_scans_and_text(tmp_path):
    stream=io.BytesIO(); c=canvas.Canvas(stream); c.drawString(40,780,'Fatura FT 2026/2'); c.showPage(); c.drawString(40,780,'Total: 246,00'); c.drawString(40,750,'Data: 09/10/2026'); c.save()
    path=tmp_path/'duas-paginas.pdf'; path.write_bytes(stream.getvalue())
    result=extract(path,'application/pdf'); assert result['pages']==2; assert result['fields']['total']==246


def test_unknown_vat_and_consumption_never_invented(env):
    app,admin,_,_=env
    for values in ({'name':'IVA desconhecido','price':10,'unit':'m²'},{'name':'Argamassa sem espessura','price':10,'unit':'saco','pack_quantity':25,'consumption':5,'vat':23}): assert admin.post('/api/private/materials',values).status_code==201
    mats=admin.get('/api/private/materials').json
    assert mats[0]['price_summary']['unit_net'] is None
    assert mats[1]['price_summary']['unit_gross'] is None
    assert mats[1]['price_summary']['vat_assumed']
    ident=mats[0]['id']; values=mats[0]['data']; values['thickness']=10
    assert admin.call('PUT',f'/api/private/materials/{ident}',values).status_code==200
    assert admin.get('/api/private/materials').json[0]['price_summary']['unit_net']==2


def test_metadata_duplicate_detection_and_revoked_pending_invite(env):
    app,admin,(eid,_),root=env; first=invoice(admin,eid); second=admin.upload(eid,raw=pdf(['Outro original ficticio']),duplicate=True).json['document']['id']
    meta=admin.get(f'/api/documents/{first}').json['metadata']
    r=admin.call('PUT',f'/api/documents/{second}',{'metadata':meta,'review':'validado'}); assert r.status_code==409
    acc,_=accountant(app,admin,eid,[first]); uid=acc.get('/api/session').json['user']['id']
    pending=admin.post('/api/invitations',{'email':'contas@example.test','scope':[{'entity_id':eid,'all_documents':True}]}); token=pending.json['path'].split('invite=')[1]
    assert admin.call('PUT',f'/api/access/{uid}',{'scope':[]}).status_code==200
    assert acc.post('/api/invitations/accept',{'token':token}).status_code==400


def test_csv_original_download_and_spreadsheet_formula_protection(env):
    app,admin,(eid,_),root=env
    raw=b'Data;Descricao;Montante\n09/10/2026;=MALICIOUS();-20,00\n'
    r=admin.client.post('/api/bank/preview',data={'entity_id':str(eid),'file':(io.BytesIO(raw),'extrato.csv')},headers={'X-CSRF-Token':admin.csrf}); assert r.status_code==200
    did=r.json['source_id']; assert admin.get(admin.get(f'/api/documents/{did}/link').json['url']).data==raw
    imported=admin.post('/api/bank/import',{'entity_id':eid,'bank':'Banco ficticio','account':'Conta','source_id':did,'rows':[{'date':'09/10/2026','description':'=MALICIOUS()','amount':-20}]}); assert imported.status_code==201
    acc,_=accountant(app,admin,eid,all_docs=True,bank=True)
    with zipfile.ZipFile(io.BytesIO(acc.get(f'/api/export?entity_id={eid}&period=2026-10').data)) as z:
        text=z.read('movimentos.csv').decode('utf-8-sig'); assert "'=MALICIOUS()" in text
        assert z.read(f'originais/{did}-extrato.csv')==raw
