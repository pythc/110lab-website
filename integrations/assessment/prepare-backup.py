"""Read-only preflight and consistent DB backups; never changes public routing.
Run on the production server. Credentials stay in process/stdin and private files.
"""
import datetime,hashlib,json,os,pathlib,sqlite3,subprocess,urllib.parse
os.umask(0o077)
BASE='sha256:465339fd9810955ed8e3e156d1c920be92eb3da8da0009df642931a22c80b5d3'
GATEWAY=pathlib.Path('/opt/ai-homework-system/releases/candidates/checkout-fa00d15/deploy/Caddyfile.public-non-ide')
EXPECTED_GATEWAY='1887b1c7ec2dc17fe9cdcaadc32857dc91f7e8b8b91c3c3acacec4111afcfcb8'
def run(args,**kwargs):return subprocess.check_output(args,stderr=subprocess.PIPE,**kwargs)
def inspect(name):return json.loads(run(['docker','inspect',name]))[0]
def digest(p):return hashlib.sha256(p.read_bytes()).hexdigest()
assessment=inspect('lab110-assessment')
assert assessment['Image']==BASE and assessment['State']['Health']['Status']=='healthy'
assert digest(GATEWAY)==EXPECTED_GATEWAY
ids=run(['docker','ps','-q'],text=True).split()
containers=json.loads(run(['docker','inspect',*ids]))
env=dict(x.split('=',1) for x in assessment['Config']['Env'])
url=urllib.parse.urlparse(env['DATABASE_URL'])
assert env.get('DB_SCHEMA','assessment')=='assessment' and (url.port or 5432)==5432
dbs=[x for x in containers if url.hostname in [x['Name'].lstrip('/'),*[a for n in x['NetworkSettings']['Networks'].values() for a in (n.get('Aliases') or [])]]]
assert len(dbs)==1
pg=dbs[0]['Name'].lstrip('/')
backup=pathlib.Path('/opt/110lab-assessment/operations')/('sso-bluegreen-preflight-'+datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ'))
backup.mkdir(mode=0o700,parents=True,exist_ok=False)
(backup/'assessment-inspect.private.json').write_text(json.dumps(assessment))
(backup/'gateway.Caddyfile').write_bytes(GATEWAY.read_bytes())
(backup/'processes.json').write_text(json.dumps({x['Name']:{'id':x['Id'],'image':x['Image'],'started':x['State']['StartedAt']} for x in containers},indent=2))
(backup/'release-pointers.json').write_text(json.dumps({name:str(pathlib.Path('/opt/'+name+'/current').resolve(strict=True)) for name in ['110lab-assessment','110lab-homepage']},indent=2))
dump=backup/'assessment.dump'
args=['docker','exec','-i',pg,'sh','-c','IFS= read -r PGPASSWORD; export PGPASSWORD; exec pg_dump --lock-wait-timeout=2000 --no-owner --no-acl -h 127.0.0.1 -U "$1" -d "$2" -n assessment -Fc','sh',urllib.parse.unquote(url.username),url.path.lstrip('/')]
with dump.open('wb') as output:
    subprocess.run(args,input=(urllib.parse.unquote(url.password)+'\n').encode(),stdout=output,stderr=subprocess.PIPE,check=True,timeout=90)
# Validate archive structure without restoring or exposing its contents.
run(['docker','exec','-i',pg,'pg_restore','--list'],input=dump.read_bytes())
count=0
for source in pathlib.Path('/opt/110lab-homepage/private').rglob('*.sqlite'):
    assert source.is_file() and not source.is_symlink()
    target=backup/('portal-'+str(source.relative_to('/opt/110lab-homepage/private')).replace('/','-'))
    with sqlite3.connect('file:'+str(source)+'?mode=ro',uri=True) as src,sqlite3.connect(target) as dst:src.backup(dst)
    with sqlite3.connect(target) as dst:assert dst.execute('PRAGMA quick_check').fetchone()[0]=='ok'
    count+=1
manifest={p.name:{'sha256':digest(p),'bytes':p.stat().st_size} for p in backup.iterdir() if p.is_file()}
(backup/'manifest.json').write_text(json.dumps(manifest,indent=2))
assert inspect('lab110-assessment')['State']['StartedAt']==assessment['State']['StartedAt']
assert digest(GATEWAY)==EXPECTED_GATEWAY
print(json.dumps({'backup':str(backup),'assessmentDumpBytes':dump.stat().st_size,'pgArchiveReadable':True,'portalDatabasesChecked':count,'processAndGatewayUnchanged':True}))
