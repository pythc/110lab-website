"""Prepare and validate both gateway files; NEVER installs or reloads them."""
import hashlib,json,pathlib,subprocess,sys
source=pathlib.Path('/opt/ai-homework-system/releases/candidates/checkout-fa00d15/deploy/Caddyfile.public-non-ide')
expected='1887b1c7ec2dc17fe9cdcaadc32857dc91f7e8b8b91c3c3acacec4111afcfcb8'
out=pathlib.Path(sys.argv[1]).resolve()
assert out.parent==pathlib.Path('/opt/110lab-assessment/operations')
assert out.name.startswith('sso-bluegreen-preflight-') and (out/'manifest.json').is_file()
old=source.read_bytes();inode=source.stat().st_ino
assert hashlib.sha256(old).hexdigest()==expected
gateway='ai-homework-public-web-1'
def caddy(command,text):
    result=subprocess.run(['docker','exec','-i',gateway,'caddy',command,'--config','/dev/stdin','--adapter','caddyfile'],input=text,capture_output=True,check=True)
    return result.stdout
baseline=json.loads(caddy('adapt',old))
def replace(value,before,after):
    if isinstance(value,str):return after if value==before else value
    if isinstance(value,list):return [replace(x,before,after) for x in value]
    if isinstance(value,dict):return {k:replace(v,before,after) for k,v in value.items()}
    return value
plan={'gateway':str(source),'baselineSha256':expected,'baselineInode':inode,'productionSwitched':False,'routes':{}}
for phase,container in [('candidate','lab110-assessment-sso-0130'),('rollback','lab110-assessment-rollback-0130')]:
    before=b'reverse_proxy lab110-assessment:5380'
    after=('reverse_proxy '+container+':5380').encode()
    assert old.count(before)==2
    data=old.replace(before,after)
    assert data.replace(after,before)==old
    config=json.loads(caddy('adapt',data))
    assert config==replace(baseline,'lab110-assessment:5380',container+':5380')
    caddy('validate',data)
    target=out/(phase+'.Caddyfile');target.write_bytes(data);target.chmod(0o600)
    plan['routes'][phase]={'file':str(target),'sha256':hashlib.sha256(data).hexdigest(),'container':container,'onlyAssessmentUpstreamsChanged':True,'validated':True}
assert source.read_bytes()==old and source.stat().st_ino==inode
(out/'routes-plan.json').write_text(json.dumps(plan,indent=2));(out/'routes-plan.json').chmod(0o600)
print(json.dumps(plan))
