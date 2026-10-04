// Portal releases can precede the assessment backend's uninterrupted rollout.
// Do not route users into an endpoint that the assessment release lacks yet.
export function assessmentEntry(value,enabled=process.env.PORTAL_ASSESSMENT_SSO_ENABLED==='true'){
  return enabled?value:value.replaceAll('https://exam.110-lab.cn/api/auth/feishu/start','https://exam.110-lab.cn/login');
}
