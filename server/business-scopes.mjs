export const BUSINESS_SCOPES = Object.freeze({
  'lab:identity':'读取本人实验室身份', 'lab:directory:read':'查找实验室成员',
  'projects:read':'读取内部项目', 'projects:write':'维护本人可编辑的项目', 'projects:review':'审核项目立项',
  'honors:read':'读取有权查看的荣誉', 'honors:write':'维护荣誉和证书', 'honors:review':'审核荣誉',
  'recruitment:read':'读取候选人资料和简历', 'recruitment:write':'维护招新记录和模板',
  'recruitment:decide':'记录录取决定', 'recruitment:send':'确认后发送面试通知', 'recruitment:sync':'确认后写入飞书招新表格',
  'mail:read':'读取授权公共邮箱邮件', 'mail:draft':'维护公共邮箱草稿', 'mail:send':'确认后使用授权公共邮箱发信',
  'updates:read':'读取动态草稿', 'updates:write':'维护动态草稿', 'updates:publish':'确认后发布或撤回官网动态',
});
export const ALL_SCOPES = Object.freeze({'mail:session':'连接实验室网页登录', ...BUSINESS_SCOPES});
export function parseScopes(value = 'mail:session') {
  const scopes = Array.isArray(value) ? value : typeof value === 'string' ? value.split(' ') : [];
  if (!scopes.length || scopes.length > Object.keys(ALL_SCOPES).length || scopes.some(s=>!Object.hasOwn(ALL_SCOPES,s)) || new Set(scopes).size!==scopes.length) throw new Error('Invalid scopes');
  return [...scopes].sort();
}
export const isLabAdmin = actor => ['admin','super_admin'].includes(actor?.role);
export function assertBusinessScope(actor, scope) {
  if (!actor?.subject) throw Object.assign(new Error('请先连接实验室身份'), {code:'AUTH_REQUIRED',status:401});
  if (!actor.scopes?.includes(scope)) throw Object.assign(new Error('需要授权此业务能力'), {code:'SCOPE_REQUIRED',status:403,scope});
  if (scope.startsWith('recruitment:')&&(scope==='recruitment:read'||actor.recruitmentRole==='hr'))return;
  if ((/^(recruitment|mail|updates):/.test(scope) || scope.endsWith(':review')) && !isLabAdmin(actor)) throw Object.assign(new Error('需要实验室管理员权限'), {code:'FORBIDDEN',status:403});
}
