// Public release information only; no client credentials or installation claims.
export const PLUGIN_RELEASE=Object.freeze({version:'0.19.0',url:'https://internal.110-lab.cn/plugin-update',downloadUrl:'https://internal.110-lab.cn/downloads/110lab-plugin-0.19.0.zip'});
export function updateOutcome(release,installedVersion){
  if(!release||!/^\d+\.\d+\.\d+$/.test(release.version)||release.url!==PLUGIN_RELEASE.url)throw new Error('更新信息无效');
  if(/^\d+\.\d+\.\d+$/.test(installedVersion||'')){
    const installed=installedVersion.split('.').map(Number),latest=release.version.split('.').map(Number);
    for(let i=0;i<3;i++){if(installed[i]>latest[i])return 'current';if(installed[i]<latest[i])return 'handoff';}
    return 'current';
  }
  return 'handoff';
}
