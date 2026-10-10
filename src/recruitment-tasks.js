export const stageNames={screening:'初筛',assessment:'考核',interview:'面试',decision:'待决定',accepted:'已录取',rejected:'未通过'};
export const taskViews=[['all','全部候选人'],['screening','待初筛'],['assessment','待考核'],['assign','待分配'],['review','待审核安排'],['scheduled','待面试'],['decision','待决定'],['attention','通知异常'],['finished','已结束']];
export function candidateTask(c){
  if(c.archived)return {key:'archived',label:'已归档',owner:'',action:'查看档案'};
  if(['accepted','rejected'].includes(c.stage))return {key:'finished',label:stageNames[c.stage],owner:'管理员',action:'查看结果'};
  if(c.stage==='screening')return {key:'screening',label:'审核简历',owner:'管理员',action:'审核简历'};
  if(c.stage==='assessment')return {key:'assessment',label:'记录考核结果',owner:'管理员',action:'处理考核'};
  if(c.stage==='decision')return {key:'decision',label:'作出录取决定',owner:'管理员',action:'查看评价'};
  if(!c.assignment&&!c.interview)return {key:'assign',label:'分配面试官',owner:'管理员',action:'分配面试官'};
  if(c.assignment?.status==='submitted'||!c.assignment&&c.interview&&!['sent','simulated','queued'].includes(c.notification?.status))return {key:'review',label:'审核面试安排',owner:'管理员',action:'审核安排'};
  if(['requested','changes_requested'].includes(c.assignment?.status))return {key:'waiting',label:c.assignment.status==='changes_requested'?'等待修改安排':'等待填写安排',owner:c.assignment.name,action:'查看进展'};
  return {key:'scheduled',label:c.interview?.at&&Date.parse(c.interview.at)<Date.now()?'等待面试评价':'等待面试',owner:c.assignment?.name||c.interview?.interviewer||'面试官',action:'查看面试'};
}
export function notificationIssue(c){
  const assignmentPending=['requested','changes_requested'].includes(c.assignment?.status);
  const states=[c.notification?.status,c.resultNotification?.status,c.receiptStatus?.toLowerCase(),assignmentPending?c.assignment?.notificationStatus?.toLowerCase():null];
  if(states.includes('unknown'))return '发送结果待核实';
  if(states.includes('failed'))return '通知发送失败';
  return '';
}
export const templateKinds={interview:'面试邀请',receipt:'投递回执',accepted:'录取通知',rejected:'未通过通知'};
export const variableNames={name:'候选人姓名',group:'应聘组别',interviewTime:'面试时间',interviewerName:'面试官姓名',interviewerEmail:'面试官邮箱',interviewerContact:'面试官联系方式',location:'会议链接',applicationId:'投递编号',decisionNote:'结果说明'};
