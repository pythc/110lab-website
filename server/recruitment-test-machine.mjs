import {createMachine, getNextSnapshot} from 'xstate';

// Pure transitions only. Persistence, permissions and side effects remain in
// the store transaction; rehydrating a candidate never sends a notification.
const machine = createMachine({
  id: 'recruitment-test',
  initial: 'screening',
  context: {},
  states: {
    screening: {on: {
      screen: [
        {guard: ({event}) => event.assessmentRequired, target: 'assessment'},
        {target: 'interview'},
      ],
      reject: 'rejected',
    }},
    assessment: {on: {assessment: 'interview', reject: 'rejected'}},
    interview: {on: {
      schedule: 'interview',
      approve_notice: {guard: ({context}) => context.notification?.status === 'draft', target: 'interview'},
      simulate_notice: {guard: ({context}) => ['approved', 'failed'].includes(context.notification?.status), target: 'interview'},
      interview: {guard: ({context}) => context.notification?.status === 'simulated', target: 'decision'},
      reject: 'rejected',
    }},
    decision: {on: {accept: 'accepted', reject: 'rejected'}},
    accepted: {on: {archive: 'accepted'}},
    rejected: {on: {archive: 'rejected'}},
  },
});

export function nextRecruitmentStage(candidate, action) {
  if (candidate.archived) return null;
  const snapshot = machine.resolveState({value: candidate.stage, context: candidate});
  const event = {...action, type: action.action};
  return snapshot.can(event) ? getNextSnapshot(machine, snapshot, event).value : null;
}
