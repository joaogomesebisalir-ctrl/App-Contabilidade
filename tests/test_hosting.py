"""Durable deployment checks against a real, disposable PostgreSQL server."""
import hashlib, io, json, os, threading, uuid, zipfile
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor

import psycopg
import pytest
from app import create_app
from app.storage import FileStore, StorageError
from test_app import Client, PASS, invoice, bank, accountant, pdf


@pytest.fixture
def pg_env(tmp_path):
    url=os.environ.get('PG_TEST_URL')
    if not url: pytest.skip('Set PG_TEST_URL to the disposable local PostgreSQL test server.')
    schema='cc_test_'+uuid.uuid4().hex[:12]
    app=create_app({'TESTING':True,'START_WORKER':False,'DATA_DIR':tmp_path,'DATABASE_URL':url,'DB_SCHEMA':schema})
    admin=Client(app); r=admin.post('/api/setup',{'email':'admin@example.test','name':'Administrador fictício','password':PASS}); assert r.status_code==200,r.json
    eid=admin.post('/api/entities',{'name':'Entidade fictícia','nif':'123456789','kind':'pessoal'}).json['id']
    yield app,admin,eid,tmp_path,url,schema
    with psycopg.connect(url) as con:
        from psycopg import sql
        con.execute(sql.SQL('DROP SCHEMA {} CASCADE').format(sql.Identifier(schema)))


def test_postgres_complete_flow_and_private_schema(pg_env):
    app,admin,eid,root,url,schema=pg_env
    did=invoice(admin,eid); mid=bank(admin,eid)
    assert admin.get(f'/api/movements/{mid}/suggestions').json[0]['document']['id']==did
    assert admin.post('/api/allocations',{'movement_id':mid,'document_id':did,'amount':50}).status_code==201
    assert admin.post('/api/allocations',{'movement_id':mid,'document_id':did,'amount':73}).status_code==201
    assert admin.get(f'/api/documents/{did}').json['paid_cents']==12300
    acc,_=accountant(app,admin,eid,[did],bank=True)
    assert acc.post(f'/api/documents/{did}/accounting',{'state':'tratado'}).status_code==200
    assert acc.get('/api/private/works').status_code==403
    assert acc.get('/api/backup').status_code==403
    assert acc.get(acc.get(f'/api/documents/{did}/link').json['url']).data.startswith(b'%PDF')
    uid=acc.get('/api/session').json['user']['id']
    oldlink=acc.get(f'/api/documents/{did}/link').json['url']
    assert admin.call('PUT',f'/api/access/{uid}',{'scope':[]}).status_code==200
    assert acc.get(oldlink).status_code==403
    with psycopg.connect(url) as con:
        from psycopg import sql
        # A new client role has no schema access, even if somebody adds it to Data API exposure.
        role='cc_anon_'+uuid.uuid4().hex[:8]
        con.execute(sql.SQL('CREATE ROLE {}').format(sql.Identifier(role))); con.commit()
        try:
            con.execute(sql.SQL('SET ROLE {}').format(sql.Identifier(role)))
            with pytest.raises(psycopg.errors.InsufficientPrivilege): con.execute(sql.SQL('SELECT * FROM {}.users').format(sql.Identifier(schema)))
            con.rollback(); con.execute('RESET ROLE')
            flags=con.execute('SELECT relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=%s AND c.relkind=%s',(schema,'r')).fetchall()
            assert flags and all(flag[0] for flag in flags)
        finally:
            con.execute(sql.SQL('DROP ROLE {}').format(sql.Identifier(role))); con.commit()


def test_postgres_restart_and_portable_backup(pg_env):
    app,admin,eid,root,url,schema=pg_env; did=invoice(admin,eid)
    wid=admin.post('/api/private/works',{'name':'Obra fictícia','budget':1000,'notes':'Nota privada fictícia'}).json['id']
    second=create_app({'TESTING':True,'START_WORKER':False,'DATA_DIR':root/'restart','DATABASE_URL':url,'DB_SCHEMA':schema})
    # A discarded local cache does not erase the database or roles.
    client=Client(second); client.login()
    assert client.get('/api/documents').json[0]['id']==did
    assert client.get(f'/api/private/works/{wid}').json['data']['notes']=='Nota privada fictícia'
    response=admin.get('/api/backup'); assert response.status_code==200
    with zipfile.ZipFile(io.BytesIO(response.data)) as z:
        payload=json.loads(z.read('dados.json'))
        assert payload['format']=='conta-clara-v1'
        assert payload['tables']['users'][0]['email']=='admin@example.test'
        assert len(payload['tables']['documents'])==1
        assert len([name for name in z.namelist() if name.startswith('files/')])==1
        assert 'password' in payload['tables']['users'][0]  # scrypt hash; backup is private.
        assert url not in z.read('dados.json').decode()


def test_postgres_prevents_concurrent_overpayment(pg_env):
    app,admin,eid,root,url,schema=pg_env; did=invoice(admin,eid,total=100); mid=bank(admin,eid,-100)
    clients=[Client(app),Client(app)]
    for client in clients: client.login()
    barrier=threading.Barrier(2)
    def pay(client):
        barrier.wait()
        return client.post('/api/allocations',{'movement_id':mid,'document_id':did,'amount':80}).status_code
    with ThreadPoolExecutor(max_workers=2) as executor: statuses=list(executor.map(pay,clients))
    assert sorted(statuses)==[201,400]
    assert admin.get(f'/api/documents/{did}').json['paid_cents']==8000


def test_cloud_requires_real_durable_configuration(tmp_path,monkeypatch):
    monkeypatch.delenv('APP_SECRET_KEY',raising=False)
    with pytest.raises(RuntimeError,match='persistência local efémera'):
        create_app({'DATA_DIR':tmp_path,'START_WORKER':False,'REQUIRE_EXTERNAL_STORAGE':True,'DATABASE_URL':None})


def test_first_admin_requires_private_setup_code(tmp_path):
    app=create_app({'DATA_DIR':tmp_path,'START_WORKER':False,'TESTING':True,'SETUP_TOKEN':'fictional-one-time-setup-code'})
    client=Client(app)
    payload={'email':'admin@example.test','name':'Fictício','password':PASS}
    assert client.get('/api/session').json['setup_requires_token']
    assert client.post('/api/setup',payload).status_code==403
    assert client.post('/api/setup',{**payload,'setup_token':'wrong-code'}).status_code==403
    assert client.post('/api/setup',{**payload,'setup_token':'fictional-one-time-setup-code'}).status_code==200
    assert client.post('/api/setup',{**payload,'setup_token':'fictional-one-time-setup-code'}).status_code==409


@pytest.fixture
def remote_store(tmp_path,monkeypatch):
    """Mock only Supabase's HTTPS protocol; neither a live Supabase project nor keys are available."""
    objects={}; bucket={'id':'conta-clara','public':False}; calls=[]
    def transport(self,path,method='GET',body=None,mime='application/json'):
        calls.append((method,path))
        if path=='/bucket/conta-clara': return json.dumps(bucket).encode()
        if path=='/object/conta-clara' and method=='DELETE':
            for key in json.loads(body)['prefixes']: objects.pop(key,None)
            return b'{}'
        name=path.split('/')[-1]
        if method=='POST': objects[name]=body; return b'{}'
        if method=='GET':
            if name not in objects: raise StorageError(404)
            return objects[name]
        raise AssertionError((method,path))
    monkeypatch.setattr(FileStore,'_request',transport)
    config={'DATA_DIR':tmp_path,'STORAGE_BACKEND':'supabase','SUPABASE_URL':'https://fictional-test-project.supabase.co','SUPABASE_STORAGE_KEY':'fictional-service-role-key'}
    store=FileStore(config); store.initialize()
    return store,objects,bucket,calls,config


def test_private_remote_files_survive_loss_of_cache(remote_store,tmp_path):
    store,objects,bucket,calls,config=remote_store
    raw=pdf(); name='a'*48+'.pdf'; checksum=hashlib.sha256(raw).hexdigest()
    store.put(name,raw,'application/pdf'); assert objects[name]==raw
    store.get_path(name).unlink()
    assert store.get_path(name,checksum).read_bytes()==raw
    restart=FileStore({**config,'DATA_DIR':tmp_path/'new-instance'}); restart.initialize()
    assert restart.get_path(name,checksum).read_bytes()==raw
    objects[name]=b'tampered'; restart.get_path(name).unlink()
    with pytest.raises(ValueError,match='integridade'): restart.get_path(name,checksum)


def test_public_bucket_is_rejected(remote_store):
    store,objects,bucket,calls,config=remote_store
    bucket['public']=True
    with pytest.raises(ValueError,match='privado'): store.initialize()


def test_supabase_hosted_permissions_and_cache_recovery(pg_env,remote_store,tmp_path):
    app,admin,eid,root,url,schema=pg_env; store,objects,bucket,calls,config=remote_store
    hosted=create_app({'TESTING':True,'START_WORKER':False,'DATA_DIR':root/'hosted','DATABASE_URL':url,'DB_SCHEMA':schema,**{k:v for k,v in config.items() if k!='DATA_DIR'}})
    client=Client(hosted); client.login(); did=invoice(client,eid)
    assert objects
    acc,_=accountant(hosted,client,eid,[did]); link=acc.get(f'/api/documents/{did}/link').json['url']
    for file in (root/'hosted'/'files').iterdir(): file.unlink()
    assert acc.get(link).data.startswith(b'%PDF')
    assert acc.get('/api/private/materials').status_code==403
    private=client.upload(eid,raw=pdf(['Orcamento privado ficticio']),private=True).json['document']['id']
    assert acc.get(f'/api/documents/{private}/link').status_code==403
