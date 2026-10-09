#!/usr/bin/env python3
"""Authorized migration from the existing Render service. Never logs secret values."""
import argparse,json,os,re,subprocess,urllib.request,urllib.error,uuid
from pathlib import Path
from urllib.parse import urlparse

ROOT=Path(__file__).resolve().parents[2]
PROJECT='wcutborzqaetmaltgyuc'
RENDER_SERVICE='srv-db4jhvc9v7es738b6d90'

def api(base,path,key,data=None,content_type='application/json',method=None):
    raw=None if data is None else (json.dumps(data).encode() if isinstance(data,(dict,list)) else data)
    request=urllib.request.Request(base+path,data=raw,headers={'Authorization':'Bearer '+key,'Content-Type':content_type},method=method)
    try:
        with urllib.request.urlopen(request,timeout=120) as response:
            result=response.read();return json.loads(result) if result else None
    except urllib.error.HTTPError as e:
        # Provider bodies can contain credentials/query text. Log status and destination only.
        raise RuntimeError(f'{urlparse(base).hostname}: HTTP {e.code} ({path.split("?")[0]})') from None

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--check-only',action='store_true');parser.add_argument('--prepare-supabase',action='store_true');args=parser.parse_args()
    names=['SUPABASE_ACCESS_TOKEN','RENDER_API_KEY']+([] if args.prepare_supabase else ['CLOUDFLARE_API_TOKEN'])
    missing=[name for name in names if not os.environ.get(name)]
    if missing:raise RuntimeError('Missing private environment bindings: '+', '.join(missing))
    sb=os.environ['SUPABASE_ACCESS_TOKEN'];render=os.environ['RENDER_API_KEY']
    entries=api('https://api.render.com',f'/v1/services/{RENDER_SERVICE}/env-vars?limit=100',render)
    config={entry['envVar']['key']:entry['envVar']['value'] for entry in entries}
    required=['SUPABASE_URL','SUPABASE_STORAGE_KEY','APP_SECRET_KEY','APP_SETUP_TOKEN','DATABASE_URL']
    if any(not config.get(k) for k in required):raise RuntimeError('Existing Render service configuration incomplete.')
    schema=config.get('APP_DB_SCHEMA','conta_clara');role=urlparse(config['DATABASE_URL']).username
    if role and role.endswith('.'+PROJECT):role=role[:-(len(PROJECT)+1)]
    if not all(re.fullmatch(r'[a-z][a-z0-9_]{0,62}',v or '') for v in [schema,role]):raise RuntimeError('Unexpected database identifiers.')
    if config['SUPABASE_URL'].rstrip('/')!=f'https://{PROJECT}.supabase.co':raise RuntimeError('Unexpected existing Supabase project.')
    print('Provider access and existing private configuration verified.')
    if args.check_only:
        if not args.prepare_supabase:
            accounts=api('https://api.cloudflare.com','/client/v4/accounts',os.environ['CLOUDFLARE_API_TOKEN'])
            if not accounts.get('success') or not accounts.get('result'):raise RuntimeError('Cloudflare account read permission required.')
        return
    # Idempotent migration: preserves all users, documents and storage objects.
    sql=(ROOT/'cloud/supabase/rpc.sql').read_text().replace('{{SCHEMA}}',schema).replace('{{ROLE}}',role)
    api('https://api.supabase.com',f'/v1/projects/{PROJECT}/database/query',sb,{'query':sql})
    print('Private database API installed.')
    api('https://api.supabase.com',f'/v1/projects/{PROJECT}/secrets',sb,[{'name':'CONTA_BACKEND_KEY','value':config['SUPABASE_STORAGE_KEY']}])
    boundary='conta'+uuid.uuid4().hex
    metadata=json.dumps({'name':'conta-password','entrypoint_path':'index.ts','verify_jwt':True})
    body=(f'--{boundary}\r\nContent-Disposition: form-data; name="metadata"\r\n\r\n{metadata}\r\n'
          f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="index.ts"\r\nContent-Type: text/plain\r\n\r\n').encode()
    body+=(ROOT/'cloud/supabase/password.ts').read_bytes()+f'\r\n--{boundary}--\r\n'.encode()
    api('https://api.supabase.com',f'/v1/projects/{PROJECT}/functions/deploy?slug=conta-password',sb,body,'multipart/form-data; boundary='+boundary)
    print('Private password function deployed.')
    if args.prepare_supabase:return
    cf=os.environ['CLOUDFLARE_API_TOKEN']
    accounts=api('https://api.cloudflare.com','/client/v4/accounts',cf)
    if not accounts.get('success') or not accounts.get('result'):raise RuntimeError('Cloudflare account read permission required.')
    chosen=os.environ.get('CLOUDFLARE_ACCOUNT_ID')
    accounts_list=[a for a in accounts['result'] if not chosen or a['id']==chosen]
    if len(accounts_list)!=1:raise RuntimeError('Set non-secret CLOUDFLARE_ACCOUNT_ID to select one accessible account.')
    account_id=accounts_list[0]['id']
    env={**os.environ,'CLOUDFLARE_ACCOUNT_ID':account_id,'XDG_CONFIG_HOME':'/tmp/conta-wrangler','WRANGLER_SEND_METRICS':'false'}
    subprocess.run(['npm','--cache','/tmp/conta-npm','run','build'],cwd=ROOT/'cloud',env=env,check=True)
    cli=str(ROOT/'cloud/node_modules/.bin/wrangler')
    subprocess.run([cli,'deploy'],cwd=ROOT/'cloud',env=env,check=True)
    secrets={name:config[name] for name in required if name!='DATABASE_URL'}
    # Send secrets directly in authenticated API bodies, never command arguments/files.
    for name,value in secrets.items():
        api('https://api.cloudflare.com',f'/client/v4/accounts/{account_id}/workers/scripts/conta-clara/secrets',cf,{'name':name,'text':value,'type':'secret_text'},method='PUT')
    subdomain=api('https://api.cloudflare.com',f'/client/v4/accounts/{account_id}/workers/subdomain',cf)
    if not subdomain.get('success') or not subdomain.get('result',{}).get('subdomain'):raise RuntimeError('Enable your workers.dev account subdomain in Cloudflare.')
    url=f"https://conta-clara.{subdomain['result']['subdomain']}.workers.dev"
    print('Published URL: '+url)
    print('Verify health, real authentication and document workflows before retiring Render.')

if __name__=='__main__':
    try:main()
    except Exception as e:
        print('Deployment stopped: '+str(e));raise SystemExit(1)
