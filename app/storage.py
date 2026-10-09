"""Private original files: local disk, or Supabase with an expendable private cache."""
import hashlib
import json
import os
import re
from pathlib import Path
from urllib.parse import quote,urlsplit
from urllib.request import Request,urlopen
from urllib.error import HTTPError,URLError


class FileStore:
    def __init__(self,config):
        self.directory=Path(config['DATA_DIR'])/'files'
        self.directory.mkdir(parents=True,exist_ok=True,mode=0o700)
        self.remote=config.get('STORAGE_BACKEND')=='supabase'
        self.url=(config.get('SUPABASE_URL') or '').rstrip('/')
        self.key=config.get('SUPABASE_STORAGE_KEY') or ''
        self.bucket=config.get('SUPABASE_BUCKET','conta-clara')
        if self.remote:
            parsed=urlsplit(self.url)
            if parsed.scheme!='https' or not parsed.hostname or not parsed.hostname.endswith('.supabase.co') or parsed.path or parsed.username or parsed.query:
                raise ValueError('SUPABASE_URL tem de ser o URL HTTPS do projeto *.supabase.co.')
            if not self.key: raise ValueError('Falta SUPABASE_STORAGE_KEY no alojamento.')
            if not re.fullmatch(r'[a-z0-9][a-z0-9-]{0,62}',self.bucket): raise ValueError('Nome de bucket inválido.')

    def _request(self,path,method='GET',body=None,mime='application/json'):
        headers={'apikey':self.key,'Content-Type':mime}
        # Legacy service_role JWTs also use Bearer; new sb_secret keys use apikey only.
        if not self.key.startswith('sb_secret_'): headers['Authorization']='Bearer '+self.key
        req=Request(self.url+'/storage/v1'+path,data=body,headers=headers,method=method)
        try:
            with urlopen(req,timeout=60) as response: return response.read(25*1024*1024+1)
        except HTTPError as exc:
            raise StorageError(exc.code) from None
        except URLError:
            raise ValueError('Armazenamento remoto indisponível. O original não foi confirmado; tente novamente.') from None

    def initialize(self):
        if not self.remote: return
        try: info=json.loads(self._request('/bucket/'+self.bucket))
        except StorageError as exc:
            if exc.code not in (400,404): raise
            payload={'id':self.bucket,'name':self.bucket,'public':False,'file_size_limit':20*1024*1024,'allowed_mime_types':['application/pdf','image/jpeg','image/png','text/csv','application/vnd.ms-excel','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']}
            self._request('/bucket','POST',json.dumps(payload).encode()); info=json.loads(self._request('/bucket/'+self.bucket))
        if info.get('public') is not False: raise ValueError('O bucket de documentos tem de ser privado. Não será usado um bucket público.')

    def _path(self,name):
        if not re.fullmatch(r'[a-f0-9]{48}\.(pdf|jpg|jpeg|png|csv|xlsx|xls)',name): raise ValueError('Nome de armazenamento inválido.')
        return self.directory/name
    def _object_url(self,name): return '/object/'+self.bucket+'/'+quote(name,safe='')
    def put(self,name,content,mime):
        path=self._path(name)
        if self.remote: self._request(self._object_url(name),'POST',content,mime)
        try:
            with path.open('xb') as f: f.write(content)
            os.chmod(path,0o600)
        except Exception:
            if self.remote: self._request('/object/'+self.bucket,'DELETE',json.dumps({'prefixes':[name]}).encode())
            raise
        return path
    def get_path(self,name,expected_sha=None):
        path=self._path(name)
        if not path.exists():
            if not self.remote: raise ValueError('O original não está disponível no armazenamento.')
            content=self._request(self._object_url(name))
            if len(content)>20*1024*1024: raise ValueError('Original excede o limite permitido.')
            if expected_sha and hashlib.sha256(content).hexdigest()!=expected_sha: raise ValueError('Falha na verificação de integridade do original.')
            # Atomic cache publication prevents concurrent readers seeing a partial file.
            import tempfile
            fd,tmp=tempfile.mkstemp(dir=self.directory)
            try:
                with os.fdopen(fd,'wb') as f: f.write(content)
                os.replace(tmp,path); os.chmod(path,0o600)
            finally: Path(tmp).unlink(missing_ok=True)
        if expected_sha and hashlib.sha256(path.read_bytes()).hexdigest()!=expected_sha: raise ValueError('Falha na verificação de integridade do original.')
        return path
    def discard_failed_upload(self,name):
        if self.remote: self._request('/object/'+self.bucket,'DELETE',json.dumps({'prefixes':[name]}).encode())
        self._path(name).unlink(missing_ok=True)


class StorageError(ValueError):
    def __init__(self,code):
        self.code=code
        super().__init__(f'Armazenamento remoto indisponível (HTTP {code}). Confirme a configuração privada e as permissões no alojamento.')
