export const mailKinds={interview:'面试邀请',receipt:'投递回执',accepted:'录取通知',rejected:'未通过通知',pre_admission:'预录取',supplement:'补充材料',reschedule:'面试改期',onboarding:'入组通知',custom:'自定义邮件'};
export function newMailTemplate(kind='custom'){
  const content={
    interview:['面试邀请','{{name}} 同学你好','面试时间：{{interviewTime}}','面试官：{{interviewerName}}','会议链接：{{location}}','联系方式：{{interviewerContact}}'],
    receipt:['简历已收到','{{name}} 同学你好','感谢你申请加入 110 实验室。你的 {{group}} 简历已收到，我们将通过邮件通知后续安排。'],
    accepted:['欢迎加入 110 实验室','{{name}} 同学你好','{{decisionNote}}'],
    rejected:['招新结果通知','{{name}} 同学你好','感谢你的时间与投入。{{decisionNote}}'],
    pre_admission:['预录取邀请','同学，你好','我们向你发出预录取邀请，期待与你一起学习、探索，把想法变成作品。','请使用考核系统账号登录，查看预录取详情，并在页面选择接受或婉拒。'],
    supplement:['补充材料','{{name}} 同学你好','为进一步了解你的经历，请补充以下资料：','请在约定时间前回复此邮件。如有疑问，欢迎联系。'],
    reschedule:['面试安排调整','{{name}} 同学你好','新的面试时间：{{interviewTime}}','会议链接：{{location}}','联系方式：{{interviewerContact}}'],
    onboarding:['入组通知','{{name}} 同学你好','欢迎加入 110 实验室。请查看以下入组安排：'],
    custom:['110 实验室通知','你好','请在这里填写正文'],
  }[kind];
  const [title,...paragraphs]=content;
  const button=kind==='pre_admission'?'<p style="text-align:center"><a href="https://exam.110-lab.cn/offer" style="display:inline-block;padding:12px 24px;background-color:#5745d6;color:#ffffff;border-radius:28px;text-decoration:none;font-weight:bold">查看我的 Offer</a></p>':'';
  return {id:crypto.randomUUID(),revision:0,name:mailKinds[kind],kind,subject:'[110实验室] '+title,body:paragraphs.join('\n\n')+'\n\n110 实验室',html:'<h2>'+title+'</h2>'+paragraphs.map(p=>'<p>'+p+'</p>').join('')+button+'<p>110 实验室</p>',variables:[]};
}
