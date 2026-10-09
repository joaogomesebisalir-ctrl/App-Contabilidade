"""SQLite for local use; private PostgreSQL schema for durable hosted deployments."""
import json
import os
import re
import sqlite3
from decimal import Decimal
from pathlib import Path
from urllib.parse import urlsplit

import psycopg
from psycopg import sql
from psycopg.rows import dict_row
from psycopg.pq import TransactionStatus

TABLES = ('users','entities','documents','grants','grant_documents','invitations',
          'movements','allocations','comments','requests','request_replies',
          'private_records','audit','login_attempts')
ID_TABLES = set(TABLES) - {'grant_documents','login_attempts'}


def normalized(row):
    if row is None: return None
    return {key:int(value) if isinstance(value,Decimal) and value==value.to_integral_value() else float(value) if isinstance(value,Decimal) else value for key,value in row.items()}


class PgCursor:
    def __init__(self,cursor,lastrowid=None):
        self.cursor=cursor; self.lastrowid=lastrowid
    def fetchone(self): return normalized(self.cursor.fetchone())
    def fetchall(self): return [normalized(row) for row in self.cursor.fetchall()]


class PgConnection:
    def __init__(self,connection): self.connection=connection
    def execute(self,query,args=()):
        if query.strip().upper()=='BEGIN IMMEDIATE':
            if self.connection.info.transaction_status==TransactionStatus.IDLE:
                self.connection.execute('BEGIN')
            # The app's monetary checks and invitation transitions share a transaction lock.
            return PgCursor(self.connection.execute('SELECT pg_advisory_xact_lock(913041337)'))
        if query.startswith('INSERT OR REPLACE INTO login_attempts'):
            query='INSERT INTO login_attempts(key,count,last) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET count=excluded.count,last=excluded.last'
        query=re.sub(r"'(?:''|[^'])*'|\?",lambda match:'%s' if match.group()=='?' else match.group(),query)
        match=re.match(r'\s*INSERT\s+INTO\s+(\w+)',query,re.I)
        returning=bool(match and match.group(1).lower() in ID_TABLES and 'RETURNING' not in query.upper())
        if returning: query=query.rstrip(';')+' RETURNING id'
        cur=self.connection.execute(query,args or None)
        return PgCursor(cur,cur.fetchone()['id'] if returning else None)
    def commit(self): self.connection.commit()
    def rollback(self): self.connection.rollback()
    def close(self): self.connection.close()


class Database:
    def __init__(self,config):
        self.url=config.get('DATABASE_URL')
        self.path=config['DATABASE']
        self.testing=config.get('TESTING',False)
        self.schema=config.get('DB_SCHEMA','conta_clara')
        if not re.fullmatch(r'[a-z][a-z0-9_]{0,62}',self.schema): raise ValueError('Nome de schema inválido.')
        self.is_postgres=bool(self.url)

    def connect(self):
        if not self.is_postgres:
            con=sqlite3.connect(self.path,timeout=30); con.row_factory=sqlite3.Row
            con.execute('PRAGMA foreign_keys=ON'); con.execute('PRAGMA busy_timeout=30000')
            return con
        host=psycopg.conninfo.conninfo_to_dict(self.url).get('host','')
        local_test=self.testing and host in ('127.0.0.1','localhost','::1')
        options={'sslmode':'disable'} if local_test else {'sslmode':'verify-full','sslrootcert':os.environ.get('APP_PG_SSL_ROOT_CERT','/etc/ssl/certs/ca-certificates.crt')}
        try:
            con=psycopg.connect(self.url,row_factory=dict_row,connect_timeout=15,
                autocommit=True,prepare_threshold=None,**options)
            # Poolers need not support the PostgreSQL startup 'options' parameter.
            con.execute(sql.SQL('SET search_path TO {}, pg_catalog').format(sql.Identifier(self.schema)))
            con.autocommit=False
        except psycopg.OperationalError as exc:
            # Connection errors can contain credential-bearing DSNs; never expose them to clients.
            raise RuntimeError('Não foi possível ligar à base de dados PostgreSQL com TLS verificado. Confirme a ligação, as credenciais e a CA no alojamento.') from None
        return PgConnection(con)

    def initialize(self,start_worker):
        schema=(Path(__file__).parent/'schema.sql').read_text()
        con=self.connect()
        try:
            if self.is_postgres:
                raw=con.connection
                raw.execute(sql.SQL('CREATE SCHEMA IF NOT EXISTS {}').format(sql.Identifier(self.schema)))
                source=re.sub(r'PRAGMA[^;]*;','',schema)
                source=source.replace(' COLLATE NOCASE','')
                source=source.replace('INTEGER PRIMARY KEY','BIGSERIAL PRIMARY KEY')
                source=re.sub(r'\bINTEGER\b','BIGINT',source); source=re.sub(r'\bREAL\b','DOUBLE PRECISION',source)
                for statement in source.split(';'):
                    if statement.strip(): raw.execute(statement)
                raw.execute('CREATE UNIQUE INDEX IF NOT EXISTS users_email_casefold ON users(lower(email))')
                raw.execute(sql.SQL('REVOKE ALL ON SCHEMA {} FROM PUBLIC').format(sql.Identifier(self.schema)))
                for table in TABLES:
                    qualified=sql.Identifier(self.schema,table)
                    raw.execute(sql.SQL('ALTER TABLE {} ENABLE ROW LEVEL SECURITY').format(qualified))
                    raw.execute(sql.SQL('REVOKE ALL ON TABLE {} FROM PUBLIC').format(qualified))
                for role in ('anon','authenticated'):
                    if raw.execute('SELECT 1 FROM pg_roles WHERE rolname=%s',(role,)).fetchone():
                        raw.execute(sql.SQL('REVOKE ALL ON SCHEMA {} FROM {}').format(sql.Identifier(self.schema),sql.Identifier(role)))
                        raw.execute(sql.SQL('REVOKE ALL ON ALL TABLES IN SCHEMA {} FROM {}').format(sql.Identifier(self.schema),sql.Identifier(role)))
            else:
                con.executescript(schema); con.execute('PRAGMA journal_mode=WAL')
            if start_worker: con.execute("UPDATE documents SET ocr_status='queued' WHERE ocr_status='processing'")
            con.commit()
        finally: con.close()
        if not self.is_postgres: os.chmod(self.path,0o600)

    def export(self,directory):
        """Consistent snapshot plus the exact catalogue of immutable originals it references."""
        con=self.connect()
        try:
            if self.is_postgres:
                con.connection.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
                tables={table:con.execute(f'SELECT * FROM {table}').fetchall() for table in TABLES}
                payload={'format':'conta-clara-v1','schema':self.schema,'tables':tables}
                name='dados.json'; (Path(directory)/name).write_text(json.dumps(payload,ensure_ascii=False),encoding='utf-8')
                docs=tables['documents']; con.commit()
            else:
                name='app.sqlite3'; dest=sqlite3.connect(Path(directory)/name); con.backup(dest); dest.close()
                snapshot=sqlite3.connect(Path(directory)/name); snapshot.row_factory=sqlite3.Row
                docs=[dict(row) for row in snapshot.execute('SELECT storage,sha256 FROM documents')]; snapshot.close()
            return name,docs
        finally: con.close()

    def secure_storage_policy(self,bucket):
        if not self.is_postgres: return
        con=self.connect()
        try:
            raw=con.connection
            if raw.execute("SELECT to_regclass('storage.objects') AS relation").fetchone()['relation']:
                roles=[r for r in ('anon','authenticated') if raw.execute('SELECT 1 FROM pg_roles WHERE rolname=%s',(r,)).fetchone()]
                if roles:
                    import hashlib
                    policy='conta_clara_private_'+hashlib.sha256(bucket.encode()).hexdigest()[:12]
                    if not raw.execute("SELECT 1 FROM pg_policies WHERE schemaname='storage' AND tablename='objects' AND policyname=%s",(policy,)).fetchone():
                        raw.execute(sql.SQL('CREATE POLICY {} ON storage.objects AS RESTRICTIVE FOR ALL TO {} USING (bucket_id <> {}) WITH CHECK (bucket_id <> {})').format(
                            sql.Identifier(policy),sql.SQL(',').join(sql.Identifier(r) for r in roles),sql.Literal(bucket),sql.Literal(bucket)))
            con.commit()
        finally: con.close()
