import type Database from 'better-sqlite3';
import { founderBeijingTime } from './founder-time.js';
import { AlignmentIssueRepository } from '../repositories/alignment-issue-repository.js';
import { AlignmentRepository } from '../repositories/alignment-repository.js';
import { loadSpaceProjectPageView, spaceProjectProgress } from './space-project-page-view.js';
import { TopicRepository } from '../repositories/topic-repository.js';
import { SpaceSyncRepository } from '../repositories/space-sync-repository.js';
import { FounderTopicProjectBindingRepository } from '../repositories/founder-topic-project-binding-repository.js';
import { buildCurrentFounderWorkMap, founderLineRootName } from './current-founder-work-map.js';
import { computeSpaceFreshness, type SpaceFreshnessSummary } from './space-sync-freshness.js';
import { founderCard, founderText } from './founder-card.js';
import type { FounderWorkMapCard } from './founder-work-map-renderer.js';
import { founderPhaseLegend, founderPhaseMark, founderPhasesTitle, type FounderBoardView, type FounderProjectProgressBoardView } from './founder-board-view.js';
import { founderCommandText } from './founder-command-text.js';

const defaultSpaceStaleAfterMinutes = 24 * 60;

export type FounderManualQuery =
  | { kind:'work_map' }
  | { kind:'project_progress';topicName:string }
  | { kind:'topic_alignment';topicName:string }
  | { kind:'open_alignment' }
  | { kind:'processing_status' };

export interface FounderManualCardQueryMessage {
  kind:'founder_manual_query'; queryMessageId:string; page:number; totalPages:number;
  targetChatId:string; card:Record<string,unknown>;
  /** 查看项目进展 only: the same content as structure, so the editable board is laid out in section order. */
  boardView?:FounderProjectProgressBoardView;
}
export type FounderManualQueryMessage=FounderManualCardQueryMessage|(FounderWorkMapCard&{
  mapId:string;targetChatId:string;manualQueryMessageId:string;boardView:FounderBoardView;
});

const baselineSince='2026-08-31T00:00:00.000Z';

export function parseFounderManualQuery(value:string):FounderManualQuery|null{
  const text=founderCommandText(value);
  if(text==='查看工作地图')return{kind:'work_map'};
  if(text==='查看待对齐'||text==='查看分歧')return{kind:'open_alignment'};
  if(text==='查看处理状态')return{kind:'processing_status'};
  const progress=/^查看项目进展\s*[:：]\s*(.{1,100})$/u.exec(text);
  if(progress?.[1]?.trim())return{kind:'project_progress',topicName:progress[1].trim()};
  const alignment=/^查看(?:对齐|分歧)\s*[:：]\s*(.{1,100})$/u.exec(text);
  return alignment?.[1]?.trim()?{kind:'topic_alignment',topicName:alignment[1].trim()}:null;
}

export function isConfiguredFounder(client:Database.Database,openId:string):boolean{
  return Boolean(openId&&client.prepare("SELECT 1 FROM founder_identities WHERE source_system='feishu' AND external_author_id=?").get(openId));
}

export function buildFounderManualQueryMessages(input:{client:Database.Database;query:FounderManualQuery;
  queryMessageId:string;chatId:string;approvedChatIds:readonly string[];now:Date;spaceStaleAfterMinutes?:number;
  /** SPACE_SYNC_WORKMAP_ENABLED: Space page summaries and status stay out of every founder view until this is on. */
  spaceWorkMapEnabled?:boolean}):FounderManualQueryMessage[]{
  const status=processingStatus(input.client,input.chatId,input.spaceWorkMapEnabled===true);
  if(input.query.kind==='work_map'){
    const result=buildWorkMap(input);
    if(result)return result.cards.map(item=>({...item,mapId:result.mapId,targetChatId:input.chatId,boardView:result.boardView,
      manualQueryMessageId:input.queryMessageId,card:withProcessingStatus(item.card,status)}));
  }
  if(input.query.kind==='processing_status')return[{kind:'founder_manual_query',queryMessageId:input.queryMessageId,page:1,totalPages:1,
    targetChatId:input.chatId,card:founderCard('处理状态',[status,processingStatusGuide],'blue')}];
  if(input.query.kind==='project_progress'){
    const progress=buildProjectProgress(input,input.query.topicName);
    // A found project carries its own one-line 资料截至 footer; the full status is one command away (查看处理状态).
    return[{kind:'founder_manual_query',queryMessageId:input.queryMessageId,page:1,totalPages:1,targetChatId:input.chatId,
      ...(progress.view?{card:progress.card,boardView:progress.view}:{card:withProcessingStatus(progress.card,status)})}];
  }
  const cards=input.query.kind==='topic_alignment'?[buildTopicAlignment(input,input.query.topicName)]:
    input.query.kind==='open_alignment'?[buildOpenAlignment(input)]:
      [founderCard('工作地图',['目前没有可展示的项目；机器人不会凭空创建项目。'])];
  return cards.map((card,index)=>({kind:'founder_manual_query',queryMessageId:input.queryMessageId,page:index+1,
    totalPages:cards.length,targetChatId:input.chatId,card:withProcessingStatus(card,status)}));
}

const stageLabels={idea:'想法',exploring:'探索中',project_candidate:'候选项目',active_project:'正在推进',paused:'暂停',closed:'已结束'} as const;

/**
 * 查看项目进展 in Ivy's order (2026-10-22): 项目定位, 阶段规划, 已完成, 正在做, 待推进, 卡点与问题, 分歧, 下一步计划, then a
 * one-line 资料截至 footer. With a Space page the sections come from the page; without one, from the group chat. A
 * group-chat item shown next to page items (positioning fallback, alignment records) is marked. An empty section says 无.
 */
function buildProjectProgress(input:{client:Database.Database;chatId:string;now:Date;spaceStaleAfterMinutes?:number;spaceWorkMapEnabled?:boolean},name:string):
  {card:Record<string,unknown>;view?:FounderProjectProgressBoardView}{
  const topics=new TopicRepository(input.client).listCanonicalTopics();
  const wanted=normalize(name),matches=topics.filter(topic=>normalize(topic.displayName)===wanted);
  if(matches.length!==1)return{card:founderCard('项目进展',[
    matches.length===0?`没有找到“${founderText(name,100)}”。请先用“查看工作地图”确认项目名称。`:
      `“${founderText(name,100)}”对应多个项目，暂不自动猜测。`],'orange')};
  const topic=matches[0]!,perspectives=new AlignmentRepository(input.client).listCanonicalPerspectives(topic.id);
  const issues=new AlignmentIssueRepository(input.client).listForTopic(topic.id)
    .filter(item=>['candidate','ready','asked'].includes(item.status));
  const pageView=input.spaceWorkMapEnabled?loadSpaceProjectPageView(input.client,topic.id,input.now,input.spaceStaleAfterMinutes??defaultSpaceStaleAfterMinutes):null;
  const page=pageView?spaceProjectProgress(pageView):null;
  const chat=(value:string)=>`${founderText(value,180)}${page?'（群聊）':''}`;
  const finished=topic.stage==='closed'||topic.stage==='paused';
  // Ivy 2026-10-22: a project with a Space page fills its sections from the page only; keyword-classified group-chat
  // statements were noise there. Group-chat progress still reaches the work map.
  const {completed:chatCompleted,next:chatNext}=finished||page?{completed:[],next:[]}:classifyFounderProgressStatements(perspectives.map(item=>item.statement));
  const unique=(items:readonly string[])=>[...new Set(items)];
  // Ivy 2026-10-24: 自媒体生产线 (B line) content runs on a fixed workflow and schedule, so it has no 阶段规划 at all.
  const noPhasePlan=founderLineRootName(input.client,topic.id)==='自媒体生产线';
  const phases=noPhasePlan?[]:page?.phases??[];
  const focus=phases.find(phase=>phase.focus)??null;
  const positioning=page?.positioning??(topic.outcome?chat(topic.outcome):'无');
  const status=`${stageLabels[topic.stage]}${focus?` · 当前重点：${focus.name}`:''}`;
  const sections=[
    {title:'已完成',items:unique([...(page?.completed??[]),...chatCompleted.slice(0,3).map(chat)])},
    {title:'正在做',items:unique(page?.inProgress??[])},
    {title:'待推进',items:unique([...(page?.pending??[]),...chatNext.slice(0,3).map(chat)])},
    {title:'卡点与问题',items:unique(page?.problems??[])},
    {title:'分歧',items:unique([...(page?.divergences??[]),...issues.slice(0,3).map(issue=>
      `Ivy：${founderText(issue.ivy.statement,100)} ↔ James：${founderText(issue.james.statement,100)}（对齐记录）`)])},
    {title:'下一步计划',items:unique(page?.nextPlan??[])}
  ];
  const facts=processingFacts(input.client,input.chatId);
  const unread=[...(facts.gaps?[`群聊 ${facts.gaps} 处（如 PDF、视频、部分附件）`]:[]),...(page?.unread??[]).map(item=>`Space ${item}`)];
  const footer=[`资料截至：群聊 ${facts.analyzedSourceAt?founderBeijingTime(facts.analyzedSourceAt):'尚无已分析消息'}${page?` · ${page.dataLine}`:''}`,
    ...(unread.length?[`未读取：${unread.join(' · ')}`]:[]),
    ...(page?.notes.length?[`Space 提示：${page.notes.join('；')}`]:[]),
    `${page?'未标注来源的条目来自 Space 页面。':''}明细发“查看处理状态”。`].join('\n');
  const view:FounderProjectProgressBoardView={kind:'project_progress',title:founderText(topic.displayName,100),positioning,status,
    phases,phasesEmpty:noPhasePlan?null:page?.phasesEmpty??'无',sections,footer};
  const phaseLine=(phase:FounderProjectProgressBoardView['phases'][number])=>`${founderPhaseMark(phase)} ${phase.name}：${phase.tasks}｜${phase.statusText}`;
  const card=founderCard(`项目进展 · ${view.title}`,[
    `项目定位\n${positioning}\n当前状态：${status}`,
    ...(view.phases.length?[`${founderPhasesTitle(view.phases)}\n${founderPhaseLegend}\n${view.phases.map(phaseLine).join('\n')}`]
      :view.phasesEmpty===null?[]:[`阶段规划\n${view.phasesEmpty}`]),
    ...sections.map(section=>`${section.title}\n${section.items.length?section.items.map(item=>`- ${item}`).join('\n'):'无'}`)
  ],issues.length?'orange':'blue');
  return{card:withFooter(card,footer),view};
}

const plannedProgress=/(?:下一步|待|计划|准备|打算|推进|需要|将|目标|希望|预计|本周|本月)/u;
const reportedDone=/(?:已|完成|上线|发布|交付|验收|解决)/u;
/**
 * Splits founder statements into completed and to-do by their wording. A statement that speaks of a plan
 * ("计划是上线…") is to-do even when it names a completion verb, so a plan is never shown as done and no
 * statement appears under both headings.
 */
export function classifyFounderProgressStatements(statements:readonly string[]):{completed:string[];next:string[]}{
  const next=statements.filter(item=>plannedProgress.test(item));
  return{completed:statements.filter(item=>!plannedProgress.test(item)&&reportedDone.test(item)),next};
}

export function enqueueFounderManualQuery(client:Database.Database,messages:readonly FounderManualQueryMessage[],at:Date):number{
  let created=0;
  for(const message of messages){
    const queryMessageId=message.kind==='founder_manual_query'?message.queryMessageId:message.manualQueryMessageId;
    const key=`founder-manual-query:${message.targetChatId}:${queryMessageId}:${message.page}`;
    created+=client.prepare(`INSERT INTO outbox(id,destination,payload,idempotency_key,status,created_at)
      VALUES(?,?,?,?, 'pending',?) ON CONFLICT(idempotency_key) DO NOTHING`)
      .run(key,message.targetChatId,JSON.stringify(message),key,at.toISOString()).changes;
  }
  return created;
}

function buildWorkMap(input:{client:Database.Database;chatId:string;approvedChatIds:readonly string[];now:Date;spaceStaleAfterMinutes?:number;spaceWorkMapEnabled?:boolean}):
  {mapId:string;cards:FounderWorkMapCard[];boardView:FounderBoardView}|null {
  const topics=new TopicRepository(input.client).listCanonicalTopics();
  if(topics.length===0)return null;
  const spacePageByTopicId=new Map(topics.flatMap(topic=>{
    if(!input.spaceWorkMapEnabled)return[];
    const view=loadSpaceProjectPageView(input.client,topic.id,input.now,input.spaceStaleAfterMinutes??defaultSpaceStaleAfterMinutes);
    return view?[[topic.id,view] as const]:[];
  }));
  const result=buildCurrentFounderWorkMap({client:input.client,chatId:input.chatId,approvedChatIds:input.approvedChatIds,
    expectedCanonicalTopicCount:topics.length,since:baselineSince,until:input.now.toISOString(),spacePageByTopicId});
  return{mapId:result.mapId,cards:result.cards,boardView:result.boardView};
}

function buildTopicAlignment(input:{client:Database.Database;now:Date},name:string):Record<string,unknown>{
  const topics=new TopicRepository(input.client).listCanonicalTopics();
  const wanted=normalize(name),matches=topics.filter(topic=>normalize(topic.displayName)===wanted);
  if(matches.length!==1)return founderCard('双方理解与待对齐',[
    matches.length===0?`没有找到“${founderText(name,100)}”。请先用“查看工作地图”确认项目名称。`:
      `“${founderText(name,100)}”对应多个项目，暂不自动猜测。`],'orange');
  const topic=matches[0]!,perspectives=new AlignmentRepository(input.client).listCanonicalPerspectives(topic.id);
  const shared=perspectives.filter(item=>item.kind==='shared_decision');
  const ivy=perspectives.filter(item=>item.kind==='ivy_view'&&item.observedAt>=topic.changedAt);
  const james=perspectives.filter(item=>item.kind==='james_view'&&item.observedAt>=topic.changedAt);
  const ivyHistory=perspectives.filter(item=>item.kind==='ivy_view'&&item.observedAt<topic.changedAt);
  const jamesHistory=perspectives.filter(item=>item.kind==='james_view'&&item.observedAt<topic.changedAt);
  const ivyConfirmedBaseline=topic.rationale==='Ivy confirmed Founder work map baseline';
  const issues=new AlignmentIssueRepository(input.client).listForTopic(topic.id)
    .filter(item=>['candidate','ready','asked'].includes(item.status));
  const lines=[`项目：${founderText(topic.displayName,120)}`,
    `${ivyConfirmedBaseline?'已确认项目结构／目标（Ivy 确认）':'当前项目目标'}：${topic.outcome?founderText(topic.outcome,500):'尚未形成明确目标。'}`,
    section('已确认共识',shared.map(item=>item.statement),'暂无双方明确确认的共识；沉默不代表同意。'),
    section('Ivy 的当前个人理解',ivy.map(item=>item.statement),ivyConfirmedBaseline?'已通过上方项目结构／目标表达当前确认。':'暂无 Ivy 的当前表达。'),
    section('James 的当前个人理解',james.map(item=>item.statement),'暂无 James 的当前表达。'),
    ...(ivyHistory.length?[section('Ivy 的历史表达',ivyHistory.map(item=>dated(item.statement,item.observedAt)),'')]:[]),
    ...(jamesHistory.length?[section('James 的历史表达',jamesHistory.map(item=>dated(item.statement,item.observedAt)),'')]:[])];
  const ivyCurrent=ivyConfirmedBaseline||ivy.length>0;
  if(!ivyCurrent||james.length===0){const missing=!ivyCurrent&&james.length===0?'双方':!ivyCurrent?'Ivy':'James';
    lines.push(`缺少另一方表达：缺少${missing==='双方'?'双方':` ${missing} `}的当前表达。`)}
  else lines.push('缺少另一方表达：双方均已有个人表达，但这不自动等于已达成共识。');
  const displayedIssues=issues.slice(0,8);
  lines.push(issues.length?`真实分歧：${issues.length} 项有双方证据且会影响行动。\n${displayedIssues.map(issue=>
    `- ${founderText(issue.ivy.statement,150)} ↔ ${founderText(issue.james.statement,150)}`).join('\n')}${issues.length>displayedIssues.length?`\n仅展示前 ${displayedIssues.length} 项，请按具体项目继续查询。`:''}`:
    '真实分歧：当前没有满足“双方都有证据且影响行动”条件的分歧；这不代表所有事项都已对齐。');
  lines.push(`原始来源：当前观点共关联 ${new Set(perspectives.flatMap(item=>item.evidenceIds)).size} 条证据，可沿原群消息追溯。`);
  return founderCard('双方理解与待对齐',lines,issues.length?'orange':'blue');
}

function buildOpenAlignment(input:{client:Database.Database}):Record<string,unknown>{
  const topics=new TopicRepository(input.client),alignment=new AlignmentRepository(input.client),issues=new AlignmentIssueRepository(input.client);
  const topicList=topics.listCanonicalTopics(),topicById=new Map(topicList.map(topic=>[topic.id,topic]));
  const missing:string[]=[];
  for(const topic of topicList){
    const views=alignment.listCanonicalPerspectives(topic.id);
    const ivy=topic.rationale==='Ivy confirmed Founder work map baseline'||
      views.some(item=>item.kind==='ivy_view'&&item.observedAt>=topic.changedAt);
    const james=views.some(item=>item.kind==='james_view'&&item.observedAt>=topic.changedAt);
    if(ivy!==james)missing.push(`${topic.displayName}：缺少 ${ivy?'James':'Ivy'} 的当前表达`);
  }
  const open=topicList.flatMap(topic=>issues.listForTopic(topic.id))
    .filter(item=>['candidate','ready','asked'].includes(item.status));
  const lines=['已确认共识、单方理解和真实分歧严格分开；没有回复不会被记成同意。',
    `缺少另一方表达：${missing.length} 项${missing.length?`\n${missing.slice(0,12).map(item=>`- ${founderText(item,180)}`).join('\n')}`:'。'}`,
    `真实分歧：${open.length} 项${open.length?`\n${open.slice(0,12).map(item=>`- ${founderText(topicById.get(item.topicId)?.displayName??item.topicId,100)}：${founderText(item.ivy.statement,100)} ↔ ${founderText(item.james.statement,100)}`).join('\n')}`:'。'}`];
  return founderCard('待对齐总览',lines,open.length?'orange':'blue');
}

function processingFacts(client:Database.Database,chatId:string){
  const received=client.prepare("SELECT MAX(received_at) value FROM founder_stream_events WHERE chat_id=? AND disposition IN ('captured','skipped_media')").get(chatId) as {value:string|null};
  const rows=client.prepare("SELECT type,status,payload,updated_at FROM batch_jobs WHERE type IN ('capture_group_message','capture_founder_attachment','analyze_founder_stream_batch')")
    .all() as {type:string;status:string;payload:string;updated_at:string}[];
  const scoped=rows.flatMap(row=>{try{const payload=JSON.parse(row.payload) as {chatId?:unknown;sourceIds?:unknown};
    return payload.chatId===chatId?[{...row,sourceIds:Array.isArray(payload.sourceIds)?payload.sourceIds.filter((id):id is string=>typeof id==='string'):[]}]:[]
  }catch{return[]}});
  const completedSources=new Set(scoped.filter(row=>row.type==='analyze_founder_stream_batch'&&row.status==='completed').flatMap(row=>row.sourceIds));
  const analyzedAt=scoped.filter(row=>row.type==='analyze_founder_stream_batch'&&row.status==='completed')
    .map(row=>row.updated_at).sort().at(-1)??null;
  const unresolvedSources=new Set(scoped.filter(row=>row.type==='analyze_founder_stream_batch'&&row.status==='failed')
    .flatMap(row=>row.sourceIds).filter(id=>!completedSources.has(id)));
  return{received:received.value,analyzedAt,analyzedSourceAt:latestSourceOccurredAt(client,[...completedSources]),
    pending:scoped.filter(row=>['queued','retry','processing'].includes(row.status)).length,unresolvedSources:unresolvedSources.size,
    invalidAnalysisJobs:scoped.filter(row=>row.type==='analyze_founder_stream_batch'&&row.status==='failed'&&row.sourceIds.length===0).length,
    failedCaptureJobs:scoped.filter(row=>['capture_group_message','capture_founder_attachment'].includes(row.type)&&row.status==='failed').length,
    gaps:countPersistedGaps(client,chatId),audit:latestCoverageAudit(client,chatId)};
}

function processingStatus(client:Database.Database,chatId:string,spaceWorkMapEnabled:boolean):string{
  const facts=processingFacts(client,chatId);
  const failureStatus=[`未补偿分析来源：${facts.unresolvedSources}`,...(facts.invalidAnalysisJobs?[`分析异常任务：${facts.invalidAnalysisJobs}`]:[]),
    `采集失败任务：${facts.failedCaptureJobs}`].join('；');
  const time=(value:string|null,empty:string)=>value?founderBeijingTime(value):empty;
  return `处理状态（北京时间）\n最后收到：${time(facts.received,'尚无记录')}\n最后完成分析：${time(facts.analyzedAt,'尚无完成记录')}\n最新已分析语料：${time(facts.analyzedSourceAt,'尚无完成记录')}\n最后防漏复核：${time(facts.audit,'尚无记录')}\n待处理：${facts.pending}；${failureStatus}；不可读/跳过缺口：${facts.gaps}\n“待处理为 0”只证明已入库任务没有积压；缺口会单独显示，不把未读取内容算作已覆盖。${spaceWorkMapEnabled?spaceProcessingStatusLine(client):''}`;
}

/** Answers Ivy's 2026-10-22 question: what each status line means and which time to check. */
const processingStatusGuide=['怎么看',
  '- 最新已分析语料：机器人已经分析到的最新一条群消息的时间。在这之后发的内容，还没进入工作地图和项目进展。最常看这一条。',
  '- 最后收到：机器人最近一次收到群消息的时间。如果比“最新已分析语料”晚很多，说明分析在排队或出错。',
  '- 最后完成分析：最近一次分析跑完的时间。',
  '- 最后防漏复核：最近一次回头核对群聊历史、补录漏掉消息的时间。',
  '- 待处理、未补偿分析来源、采集失败任务：正常都是 0；不是 0 说明有积压或失败，需要排查。',
  '- 不可读/跳过缺口：机器人读不了的内容数量（如 PDF、视频、部分附件），这些内容不计入进展。',
  '- Space 页面 · 最后成功同步：项目页最近一次导入的时间。之后在页面上的修改还没进来。'].join('\n');

/** Aggregate, read-only summary over already-stored bindings/runs — never contacts Space itself. */
function spaceProcessingStatusLine(client:Database.Database):string{
  const spaceSync=new SpaceSyncRepository(client);
  const bindings=spaceSync.listBindings();
  if(bindings.length===0)return'';
  const active=bindings.filter(b=>b.status==='active').length;
  const permissionLost=bindings.filter(b=>b.status==='permission_lost').length;
  const latestSync=bindings.map(b=>b.lastSuccessfulSyncAt).filter((v):v is string=>Boolean(v)).sort().at(-1)??null;
  const gapCount=bindings.reduce((sum,b)=>sum+(spaceSync.getLatestRunForBinding(b.id)?.gapCount??0),0);
  return `\nSpace 页面\n已绑定项目：${bindings.length}；活跃：${active}；权限缺失：${permissionLost}\n最后成功同步：${latestSync?founderBeijingTime(latestSync):'尚无记录'}\n缺口：${gapCount}`;
}

function latestSourceOccurredAt(client:Database.Database,sourceIds:readonly string[]):string|null{
  let latest:string|null=null;
  for(let offset=0;offset<sourceIds.length;offset+=500){const chunk=sourceIds.slice(offset,offset+500);if(!chunk.length)continue;
    const row=client.prepare(`SELECT MAX(occurred_at) AS value FROM context_sources WHERE id IN (${chunk.map(()=>'?').join(',')})`)
      .get(...chunk) as {value:string|null};if(row.value&&(!latest||row.value>latest))latest=row.value}
  return latest;
}

function latestCoverageAudit(client:Database.Database,chatId:string):string|null{
  const rows=client.prepare("SELECT captured_at,metadata_json,content_text FROM context_sources WHERE source_type='feishu_sync_coverage' ORDER BY captured_at DESC")
    .all() as {captured_at:string;metadata_json:string;content_text:string}[];
  for(const row of rows)try{
    const metadata=JSON.parse(row.metadata_json) as {chatId?:unknown};
    const content=JSON.parse(row.content_text) as {requestedRange?:{until?:unknown};sourceCoverage?:{termination?:unknown}};
    const until=content.requestedRange?.until;
    if(metadata.chatId===chatId&&content.sourceCoverage?.termination==='next_cursor_null'&&typeof until==='string'&&
      Number.isFinite(Date.parse(until)))return new Date(until).toISOString();
  }catch{}
  return null;
}

function withFooter(card:Record<string,unknown>,footer:string):Record<string,unknown>{
  const elements=Array.isArray(card.elements)?card.elements:[];
  return{...card,elements:[...elements,{tag:'hr'},{tag:'div',text:{tag:'plain_text',content:footer}}]};
}

function withProcessingStatus(card:Record<string,unknown>,status:string):Record<string,unknown>{
  const elements=Array.isArray(card.elements)?card.elements:[];
  const result={...card,elements:[...elements,{tag:'hr'},{tag:'div',text:{tag:'plain_text',content:status}}]};
  return Buffer.byteLength(JSON.stringify(result),'utf8')<=28_000?result:
    founderCard('查询结果过长',[status,'结果超过飞书单卡安全上限，请缩小到具体项目后再次查询。'],'orange');
}

function countPersistedGaps(client:Database.Database,chatId:string):number{
  const rows=client.prepare("SELECT source_type,content_text,metadata_json FROM context_sources WHERE source_type IN ('feishu_sync_gap','feishu_sync_coverage')")
    .all() as {source_type:string;content_text:string;metadata_json:string}[];
  const unique=new Set<string>();
  const remember=(value:unknown)=>{if(typeof value!=='object'||value===null)return;
    const gap=value as {code?:unknown;sourceRef?:unknown};
    if(typeof gap.code==='string'&&typeof gap.sourceRef==='string')unique.add(`${gap.code}\n${gap.sourceRef}`)};
  for(const row of rows)try{
    const metadata=JSON.parse(row.metadata_json) as {chatId?:unknown;gaps?:unknown};
    if(metadata.chatId!==chatId)continue;
    if(row.source_type==='feishu_sync_gap'){remember(JSON.parse(row.content_text));continue}
    const content=JSON.parse(row.content_text) as {gaps?:unknown};
    const gaps=Array.isArray(content.gaps)?content.gaps:Array.isArray(metadata.gaps)?metadata.gaps:[];
    gaps.forEach(remember);
  }catch{/* Malformed audit rows are not treated as readable coverage. */}
  return unique.size;
}

function section(title:string,values:readonly string[],empty:string):string{
  return `${title}\n${values.length?values.map(value=>`- ${founderText(value,260)}`).join('\n'):empty}`;
}

function dated(statement:string,observedAt:string):string{
  return `${observedAt.slice(0,10)}｜${statement}`;
}

function normalize(value:string):string{return value.normalize('NFKC').toLocaleLowerCase('zh-CN').replace(/[\p{P}\p{S}\s]+/gu,'')}
