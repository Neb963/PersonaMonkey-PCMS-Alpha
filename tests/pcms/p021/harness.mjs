export const UID_A="11111111-1111-4111-8111-111111111111";
export const UID_B="22222222-2222-4222-8222-222222222222";

const clone=(value)=>structuredClone(value);

export function account(overrides={}) {
  return {
    schemaVersion:1,
    kind:"account",
    accountId:"account-1",
    providerId:"perchance",
    displayName:"Primary Account",
    personaUid:UID_A,
    bindingEpoch:1,
    createdAt:"2026-10-05T10:00:00.000Z",
    updatedAt:"2026-10-05T10:00:00.000Z",
    ...overrides
  };
}

export function task(overrides={}) {
  return {
    key:overrides.taskId||"task-normal",
    revision:1,
    updatedAt:"2026-10-05T10:00:00.000Z",
    value:{
      schemaVersion:1,
      kind:"human-task",
      taskId:"task-normal",
      taskKind:"operator.review",
      title:"Review account",
      instructions:"This field must never enter search projection output",
      priority:"NORMAL",
      subjectRef:{kind:"account",id:"account-1"},
      state:"OPEN",
      resolutionCode:null,
      createdAt:"2026-10-05T10:00:00.000Z",
      completedAt:null,
      ...overrides
    }
  };
}

export function makeSources({accounts=[account()],attention=[task()]}={}) {
  const calls={accounts:0,attention:0};
  return Object.freeze({
    calls,
    accounts:Object.freeze({
      async listAccounts(){
        calls.accounts+=1;
        return Object.freeze({revision:3,accounts:Object.freeze(clone(accounts))});
      }
    }),
    humanTasks:Object.freeze({
      async listAttention({limit}={}){
        calls.attention+=1;
        return Object.freeze(clone(attention).slice(0,limit));
      }
    })
  });
}
