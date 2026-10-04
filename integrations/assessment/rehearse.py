"""Run a real Docker/Caddy/PG rehearsal without production mounts or routing.

Run on the server: python3 rehearse.py /absolute/path/to/prepared-build-context
The context contains candidate/, rollback/ and rehearsal-fixture.mjs.
Only containers with this run's label may be removed. No production env is read.
"""
import hashlib,json,os,pathlib,secrets,subprocess,sys,time

BASE='sha256:465339fd9810955ed8e3e156d1c920be92eb3da8da0009df642931a22c80b5d3'
CADDY='sha256:d3d8033fd5212cc823e17598d0d600184dd4fc37d687f38ea3c2d47e96f4c3d8'
GATEWAY=pathlib.Path('/opt/ai-homework-system/releases/candidates/checkout-fa00d15/deploy/Caddyfile.public-non-ide')
root=pathlib.Path(sys.argv[1]).resolve()
assert root.parent==pathlib.Path('/opt/110lab-assessment/rehearsals')
runid='sso-rehearsal-'+secrets.token_hex(4)
names={k:runid+'-'+k for k in ['pg','old','candidate','rollback','gateway']}
created=[];monitor=None;report={'run':runid,'productionSwitched':False}

def run(args,timeout=45):
    try:return subprocess.check_output(args,stderr=subprocess.STDOUT,text=True,timeout=timeout)
    except subprocess.CalledProcessError as exc:
        # Only isolated fixtures run here. Avoid dumping command/env arguments.
        raise RuntimeError('Rehearsal command failed: '+exc.output[-2500:]) from None
def inspect(name):return json.loads(run(['docker','inspect',name]))[0]
def image(name):return json.loads(run(['docker','image','inspect',name]))[0]
def digest(path):return hashlib.sha256(path.read_bytes()).hexdigest()
def snapshot():
    ids=run(['docker','ps','-q']).split()
    return {r['Name']:{'id':r['Id'],'started':r['State']['StartedAt']} for r in json.loads(run(['docker','inspect',*ids]))}
def start(role,args):
    name=names[role]
    cid=run(['docker','run','-d','--name',name,'--label','110lab.sso-rehearsal='+runid,'--network',runid,*args]).strip()
    created.append(name);return cid
def node(role,mode,timeout=60):
    return run(['docker','exec',names[role],'node','/rehearsal/rehearsal-fixture.mjs',mode],timeout)
def ready(role):
    for _ in range(50):
        try:
            run(['docker','exec',names[role],'node','-e',"fetch('http://127.0.0.1:5380/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"],8)
            return
        except RuntimeError:time.sleep(.3)
    raise RuntimeError(role+' not ready')

before=snapshot();gateway_hash=digest(GATEWAY)
assert inspect('lab110-assessment')['Image']==BASE
assert inspect('lab110-assessment')['State']['Health']['Status']=='healthy'
assert int(dict(line.split(':',1) for line in pathlib.Path('/proc/meminfo').read_text().splitlines())['MemAvailable'].split()[0])>400_000
assert os.statvfs(root).f_bavail*os.statvfs(root).f_frsize>2*1024**3
pg=image('47befb84c863')['Id']
base_tag='110lab-sso-base:'+BASE[-12:]
run(['docker','tag',BASE,base_tag])
for role in ['candidate','rollback']:
    dockerfile=(root/role/'Dockerfile').read_text()
    assert dockerfile.splitlines()[0]=='FROM '+base_tag
    run(['docker','build','--network','none','--pull=false','-t','110lab-sso-'+role+':'+root.name,str(root/role)],120)
    report[role+'Image']=image('110lab-sso-'+role+':'+root.name)['Id']
shared=root/(runid+'-shared');shared.mkdir(mode=0o755,exist_ok=True)
os.chown(shared,1000,1000)
(shared/'rehearsal-fixture.mjs').write_bytes((root/'rehearsal-fixture.mjs').read_bytes())
(shared/'hosts.json').write_text(json.dumps(names))
(shared/'Caddyfile').write_text('{\n admin 0.0.0.0:2019\n auto_https off\n}\n:8080 {\n reverse_proxy '+names['old']+':5380\n}\n')
storage=root/(runid+'-storage');storage.mkdir(mode=0o700,exist_ok=True);os.chown(storage,1000,1000)
password=secrets.token_hex(24)
env=['--env','NODE_ENV=production','--env','PORT=5380','--env','APP_ORIGIN=https://exam.110-lab.cn','--env','PUBLIC_BASE_URL=https://exam.110-lab.cn','--env','COOKIE_SECURE=true','--env','DATABASE_URL=postgres://postgres:'+password+'@'+names['pg']+':5432/lab_rehearsal','--env','SESSION_SECRET='+secrets.token_hex(32),'--env','STORAGE_DIR=/data','--env','PG_POOL_MAX=3','--env','ASSESSMENT_WORKERS_ENABLED=false']
common=['--memory','160m','--cpus','0.5','--cap-drop','ALL','--security-opt','no-new-privileges','--mount','type=bind,src='+str(shared)+',dst=/rehearsal','--mount','type=bind,src='+str(storage)+',dst=/data',*env]
try:
    run(['docker','network','create','--internal','--label','110lab.sso-rehearsal='+runid,runid])
    start('pg',['--memory','128m','--cpus','0.5','--env','POSTGRES_PASSWORD='+password,'--env','POSTGRES_DB=lab_rehearsal','--tmpfs','/var/lib/postgresql/data',pg])
    for _ in range(50):
        if subprocess.run(['docker','exec',names['pg'],'pg_isready','-U','postgres'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode==0:break
        time.sleep(.3)
    else:raise RuntimeError('Isolated PG not ready')
    start('old',[*common,BASE]);ready('old')
    report['seed']=json.loads(node('old','seed'))
    start('gateway',['--memory','80m','--cpus','0.5','--mount','type=bind,src='+str(shared)+',dst=/rehearsal,readonly','--entrypoint','caddy',CADDY,'run','--config','/rehearsal/Caddyfile','--adapter','caddyfile'])
    time.sleep(1)
    monitor=subprocess.Popen(['docker','exec',names['old'],'node','/rehearsal/rehearsal-fixture.mjs','monitor'],stdout=subprocess.DEVNULL,stderr=subprocess.PIPE)
    start('candidate',[*common,'--env','LAB_SSO_ENABLED=true','--env','LAB_SSO_FREEZE_FILE=/rehearsal/sso-frozen',report['candidateImage']]);ready('candidate')
    start('rollback',[*common,report['rollbackImage']]);ready('rollback')
    report['exercise']=json.loads(node('candidate','exercise',150))
    for role in ['candidate','rollback']:
        logs=run(['docker','logs',names[role]])
        assert '"event":"assessment-workers","enabled":false' in logs
    report['workersDisabledOnNewHttp']=True
    (shared/'stop-monitor').touch();monitor.wait(timeout=15)
    assert monitor.returncode==0
    report.update(json.loads((shared/'exercise-result.json').read_text()))
    report['continuousRequests']=json.loads((shared/'monitor-result.json').read_text())
    assert report['continuousRequests']['samples']>=20
    assert not report['continuousRequests']['failures']
    report['passed']=True
finally:
    if monitor and monitor.poll() is None:
        (shared/'stop-monitor').touch()
        try:monitor.wait(timeout=15)
        except subprocess.TimeoutExpired:monitor.terminate();monitor.wait(timeout=5)
    for name in reversed(created):
        r=inspect(name)
        assert r['Config']['Labels'].get('110lab.sso-rehearsal')==runid
        run(['docker','rm','-f',name])
    net=json.loads(run(['docker','network','inspect',runid]))[0]
    assert net['Labels'].get('110lab.sso-rehearsal')==runid
    run(['docker','network','rm',runid])
    report['productionProcessesUnchanged']=all(snapshot().get(k)==v for k,v in before.items())
    report['productionGatewayUnchanged']=digest(GATEWAY)==gateway_hash
    (root/'report.json').write_text(json.dumps(report,indent=2))
    assert report['productionProcessesUnchanged'] and report['productionGatewayUnchanged']
    print(json.dumps(report))
