const string={type:'string'};
const boolean={type:'boolean'};
const integer={type:'integer'};
const array=items=>({type:'array',items});
const nullable=value=>({anyOf:[value,{type:'null'}]});
const shape=properties=>({type:'object',additionalProperties:false,required:Object.keys(properties),properties});
const choice=shape({label:string,text:string});
const model=shape({runtime:string,model:string,effort:string});
const criteria={anyOf:[string,array(string)]};
const role=shape({key:string,role:string,name:nullable(string),roleTitle:nullable(string),description:string,
  trainingTopics:nullable(array(string)),recommendation:nullable(model)});
const task=shape({key:string,title:string,prompt:string,criteria,agentKey:string,reviewerKey:string,dependsOn:array(string),
  artifactPath:nullable(string),requiresAcceptance:nullable(boolean),deliveryMode:nullable(string),kind:nullable(string),
  debtTaskId:nullable(string),backlogTaskId:nullable(string),points:nullable(integer),debtCategory:nullable(string)});
const question=shape({kind:{type:'string',enum:['technical','owner']},title:string,body:string,
  choices:array(shape({label:string,answer:string}))});
const taskResult={summary:string,artifact:nullable(string),artifactPath:nullable(string),question:nullable(question),
  improvements:nullable(array(shape({title:string,reason:string,acceptance:string})))};

export const responseSchemas={
  plan:shape({title:string,goal:string,epic:shape({title:string,description:string}),story:shape({title:string,acceptance:criteria}),
    epicId:nullable(string),storyId:nullable(string),phaseId:nullable(string),agents:array(role),tasks:array(task),
    files:array(shape({path:string,content:string})),ownerReplies:array(choice)}),
  task:shape(taskResult),
  imageTask:shape({...taskResult,imageSlots:nullable(array(integer))}),
  selectModel:model,
  train:shape({summary:string,selectedSkillIds:array(string),guide:string,selectedMaterialIds:array(string),
    exerciseTask:nullable(string),
    knowledge:nullable(string),knowledgeKey:nullable(string),knowledgeReason:nullable(string),
    customSkills:array(shape({key:string,title:string,description:string,content:string}))}),
  exercise:shape({summary:string}),
  review:shape({pass:boolean,summary:string,ownerReplies:nullable(array(choice))}),
  director:shape({action:{type:'string',enum:['next','nextSprint','finish','train','hire']},summary:nullable(string),
    taskKey:nullable(string),objective:nullable(string),topics:nullable(array(string)),estimatedBudget:nullable({type:'number'}),
    agent:nullable(shape({key:string,role:string,name:nullable(string),roleTitle:nullable(string),description:string}))}),
  blocker:shape({nextStep:string}),
  inbox:shape({action:{type:'string',enum:['explain','clarify','approve','revise','answer','retry']},
    text:string,reworkTaskId:nullable(string),researchIntent:nullable({type:'string',enum:['search','none']}),
    webResearch:nullable(shape({sources:array(shape({url:string,note:nullable(string),
      status:{type:'string',enum:['found','read','failed']}})),unverified:array(string)}))}),
};

// The wire format uses explicit null for optional fields. Domain validators also accept
// the older format, in which those fields were absent.
export function omitAbsentFields(value) {
  if(Array.isArray(value)) return value.map(omitAbsentFields);
  if(!value || typeof value!=='object') return value;
  return Object.fromEntries(Object.entries(value).filter(([,field])=>field!==null)
    .map(([key,field])=>[key,omitAbsentFields(field)]));
}
